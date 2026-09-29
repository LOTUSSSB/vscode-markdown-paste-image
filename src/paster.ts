import * as path from "path";
import * as vscode from "vscode";
import * as xclip from "xclip";
import { toMarkdown } from "./toMarkdown";
import { Predefine } from "./predefine";
import { AIPaster } from "./ai_paster";
import {
  prepareDirForFile,
  fetchAndSaveFile,
  newTemporaryFilename,
  base64Encode,
  isRemoteMode,
} from "./utils";
import { existsSync, rmSync, RmOptions } from "fs";
import { LanguageDetection } from "./language_detection";
import Logger from "./Logger";

class PasteImageContext {
  targetFile?: vscode.Uri;
  convertToBase64: boolean;
  removeTargetFileAfterConvert: boolean;
  imgTag?: {
    width: string;
    height: string;
  } | null;
}

interface PasteTarget {
  editor: vscode.TextEditor;
  selection: vscode.Selection;
}

class Paster {
  public static async pasteCode() {
    const target = Paster.captureTarget();
    if (!target) return;
    const shell = xclip.getShell();
    const cb = shell.getClipboard();
    const content = await cb.getTextPlain();
    if (content) {
      let ld = new LanguageDetection();
      let lang = await ld.detectLanguage(content);
      Paster.writeToEditor(`\`\`\`${lang}\n${content}\n\`\`\``, target);
    }
  }

  static async parseByAI(content: string, target: PasteTarget) {
    if (Paster.getConfig(target.editor).enableAI) {
      const p = new AIPaster(target.editor, target.selection);
      const result = await p.callAI(content);
      if (result.status == "success") {
        await Paster.writeToEditor(result.message, target);
        return;
      }
    }
    Paster.writeToEditor(content, target);
  }

  static async selectClipboardType(
    type: Set<xclip.ClipboardType> | xclip.ClipboardType,
    config = Paster.config
  ): Promise<xclip.ClipboardType> {
    if (!(type instanceof Set)) {
      return type;
    }
    if (
      config.autoSelectClipboardType == "never" ||
      (config.autoSelectClipboardType == "html&text" &&
        type.has(xclip.ClipboardType.Image))
    ) {
      const selected = await vscode.window.showInformationMessage(
        "There are multiple types of content in your clipboard. Which one do you want to use?",
        {
          modal: true,
        },
        ...Array.from(type)
      );
      if (selected) {
        return selected;
      }
      return xclip.ClipboardType.Unknown;
    }
    const priorityOrdering = config.autoSelectClipboardTypePriority;
    for (const theType of priorityOrdering)
      if (type.has(theType)) return theType;
    return xclip.ClipboardType.Unknown;
  }

  /**
   * Paste text
   */
  public static async paste() {
    const target = Paster.captureTarget();
    if (!target) return;
    const config = Paster.getConfig(target.editor);
    const shell = xclip.getShell();
    const cb = shell.getClipboard();
    const ctx_type = await this.selectClipboardType(
      await Paster.getClipboardContentType(shell, cb),
      config
    );

    let enableHtmlConverter = config.enableHtmlConverter;
    let enableRulesForHtml = config.enableRulesForHtml;
    let turndownOptions = config.turndownOptions;

    Logger.log("Clipboard Type:", ctx_type);
    switch (ctx_type) {
      case xclip.ClipboardType.Html:
        if (enableHtmlConverter) {
          const html = await cb.getTextHtml();
          let markdown = toMarkdown(html, turndownOptions);
          if (enableRulesForHtml) {
            markdown = Paster.parse(markdown, target);
          }
          await Paster.parseByAI(markdown, target);
        } else {
          const text = await cb.getTextPlain();
          if (text) {
            let newContent = Paster.parse(text, target);
            await Paster.parseByAI(newContent, target);
          }
        }
        break;
      case xclip.ClipboardType.Text:
        const text = await cb.getTextPlain();
        if (text) {
          let newContent = Paster.parse(text, target);
          await Paster.parseByAI(newContent, target);
        }
        break;
      case xclip.ClipboardType.Image:
        if (false === isRemoteMode()) {
          Paster.pasteImage(target);
        } else {
          // show warring dialog
          Logger.showErrorMessage(
            "Paste Image is not available in Remote Mode (SSH, WSL, Dev Container). " +
              "Please paste the image locally, or use VS Code’s built-in paste feature instead."
          );
        }
        break;
      case xclip.ClipboardType.Unknown:
        Logger.log("Unknown type");
        break;
    }
  }

  /**
   * Download url content in clipboard
   */
  public static async pasteDownload() {
    const target = Paster.captureTarget();
    if (!target) return;
    const config = Paster.getConfig(target.editor);
    const shell = xclip.getShell();
    const cb = shell.getClipboard();
    const ctx_type = await this.selectClipboardType(
      await Paster.getClipboardContentType(shell, cb),
      config
    );
    Logger.log("Clipboard Type:", ctx_type);
    switch (ctx_type) {
      case xclip.ClipboardType.Html:
      case xclip.ClipboardType.Text:
        const text = await cb.getTextPlain();
        if (text) {
          if (/^(http[s]:)+\/\/(.*)/i.test(text)) {
            Paster.pasteImageURL(text, target);
          }
        }
        break;
    }
  }
  /**
   * Ruby tag
   */
  public static Ruby() {
    let editor = vscode.window.activeTextEditor;
    if (!editor) return;
    let rubyTag = new vscode.SnippetString(
      "<ruby>${TM_SELECTED_TEXT}<rp>(</rp><rt>${1:pronunciation}</rt><rp>)</rp></ruby>"
    );
    editor.insertSnippet(rubyTag);
  }

  private static captureTarget(): PasteTarget | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    return {
      editor,
      selection: new vscode.Selection(
        editor.selection.start,
        editor.selection.end
      ),
    };
  }

  private static async getClipboardContentType(shell, clipboard) {
    if (process.platform !== "darwin") {
      return clipboard.getContentType();
    }

    try {
      const scriptPath = path.resolve(
        __dirname,
        "../res/scripts/macos_get_clipboard_content_type.applescript"
      );
      const contentTypes = await shell.runScript(scriptPath);
      const detectedTypes = new Set<xclip.ClipboardType>();
      for (const contentType of contentTypes.split(/\r\n|\n|\r/)) {
        switch (contentType.trim()) {
          case "Image":
          case "File":
            detectedTypes.add(xclip.ClipboardType.Image);
            break;
          case "HTML":
            detectedTypes.add(xclip.ClipboardType.Html);
            break;
          case "Text":
            detectedTypes.add(xclip.ClipboardType.Text);
            break;
        }
      }

      if (detectedTypes.size === 0) return xclip.ClipboardType.Unknown;
      if (detectedTypes.size === 1) return detectedTypes.values().next().value;
      return detectedTypes;
    } catch (error) {
      Logger.log("macOS clipboard type detection failed:", String(error));
      return clipboard.getContentType();
    }
  }

  private static async getClipboardImage(shell, clipboard, imagePath: string) {
    if (process.platform !== "darwin") {
      return clipboard.getImage(imagePath);
    }

    try {
      const scriptPath = path.resolve(
        __dirname,
        "../res/scripts/macos_save_clipboard_png.applescript"
      );
      const result = await shell.runScript(scriptPath, [imagePath]);
      if (result) return result;
    } catch (error) {
      Logger.log("macOS clipboard image read failed:", String(error));
    }
    return clipboard.getImage(imagePath);
  }

  private static writeToEditor(
    content: string,
    target: PasteTarget
  ): Thenable<boolean> {
    return target.editor.edit((editBuilder) => {
      editBuilder.delete(target.selection);
      editBuilder.insert(target.selection.start, content);
    });
  }

  static getConfig(editor = vscode.window.activeTextEditor) {
    if (!editor) return vscode.workspace.getConfiguration("MarkdownPaste");

    let fileUri = editor.document.uri;
    if (!fileUri) return vscode.workspace.getConfiguration("MarkdownPaste");

    return vscode.workspace.getConfiguration("MarkdownPaste", fileUri);
  }

  static get config() {
    return Paster.getConfig();
  }

  /**
   * Returns the first matching image rule (if any) based on the current Markdown file path.
   * Preprocesses variables (including timestamp) once and reuses them in both targetPath and linkPattern.
   */
  private static getMatchingImageRule(target: PasteTarget): any {
    const editor = target.editor;
    const config = Paster.getConfig(editor);
    const rules = config.imageRules;
    if (!rules) return null;
    if (!editor) return null;
    const currentFilePath = editor.document.uri.fsPath;
    for (const rule of rules) {
      if (rule.match) {
        const re = new RegExp(rule.match, rule.options || "");
        const match = re.exec(currentFilePath);
        if (match) {
          let processedRule = { ...rule };
          if (processedRule.targetPath) {
            processedRule.targetPath = Predefine.replacePredefinedVars(
              processedRule.targetPath,
              editor,
              target.selection
            );
            match.forEach((value, index) => {
              if (index === 0) return;
              processedRule.targetPath = processedRule.targetPath.replaceAll(
                `$${index}`,
                value
              );
            });
          }
          if (processedRule.linkPattern) {
            processedRule.linkPattern = Predefine.replacePredefinedVars(
              processedRule.linkPattern,
              editor,
              target.selection
            );
            match.forEach((value, index) => {
              if (index === 0) return;
              processedRule.linkPattern = processedRule.linkPattern.replaceAll(
                `$${index}`,
                value
              );
            });
          }
          return processedRule;
        }
      }
    }
    return null;
  }

  /**
   * Generate a path for the target image.
   * @param extension Extension of target image file.
   * @returns The generated image path.
   */
  private static genTargetImagePath(
    target: PasteTarget,
    extension: string = ".png"
  ): string {
    const editor = target.editor;
    if (!editor) return;
    let fileUri = editor.document.uri;
    if (!fileUri) return;
    if (fileUri.scheme === "untitled") {
      vscode.window.showInformationMessage(
        "Before pasting an image, you need to save the current edited file first."
      );
      return;
    }

    // Check if a custom image rule applies.
    const rule = Paster.getMatchingImageRule(target);
    if (rule && rule.targetPath) {
      let targetPattern = rule.targetPath;
      // targetPattern is already processed in getMatchingImageRule
      // If the rule's pattern does not include an extension, append it.
      if (path.extname(targetPattern) === "") {
        targetPattern += extension;
      }
      return targetPattern;
    }

    // Fallback: default behavior.
    const filePath = fileUri.fsPath;
    const config = Paster.getConfig(editor);
    let folderPathFromConfig = config.path;
    folderPathFromConfig = Predefine.replacePredefinedVars(
      folderPathFromConfig,
      editor,
      target.selection
    );

    let imageFileName = "";
    const namePrefix = config.namePrefix;
    const nameBase = config.nameBase;
    const nameSuffix = config.nameSuffix;
    imageFileName = namePrefix + nameBase + nameSuffix + extension;
    imageFileName = Predefine.replacePredefinedVars(
      imageFileName,
      editor,
      target.selection
    );

    const folderPath = path.dirname(filePath);
    let imagePath = "";
    if (path.isAbsolute(folderPathFromConfig)) {
      imagePath = path
        .join(folderPathFromConfig, imageFileName)
        .replace(/\\/g, "/");
    } else {
      imagePath = path
        .join(folderPath, folderPathFromConfig, imageFileName)
        .replace(/\\/g, "/");
    }
    return imagePath;
  }

  /**
   * Generate Markdown link for a saved image.
   */
  private static renderMdFilePath(
    pasteImgContext: PasteImageContext,
    target: PasteTarget = Paster.captureTarget()
  ): string {
    if (!target) return;
    const editor = target.editor;
    if (!editor) return;
    const fileUri = editor.document.uri;
    if (!fileUri) return;

    let basePath: string;

    const config = Paster.getConfig(editor);
    const customBasePath = config.get<string>("basePath");

    if (customBasePath && customBasePath.trim() !== "") {
      basePath = path.resolve(
        Predefine.replacePredefinedVars(
          customBasePath,
          editor,
          target.selection
        )
      );
    } else {
      // Original behavior
      basePath = path.dirname(fileUri.fsPath);
    }

    let imageFilePath = path.relative(
      basePath,
      pasteImgContext.targetFile.fsPath
    );
    imageFilePath = imageFilePath.replace(/\\/g, "/");

    if (
      customBasePath &&
      !path.isAbsolute(imageFilePath) &&
      !imageFilePath.startsWith("/")
    ) {
      imageFilePath = "/" + imageFilePath;
    }

    imageFilePath = Paster.encodePath(imageFilePath, editor);

    // Apply any language rules (if configured).
    const parse_result = Paster.parse_rules(imageFilePath, target);
    if (typeof parse_result === "string") {
      return parse_result;
    }

    // If a custom link pattern is defined via a matching rule, use it.
    const rule = Paster.getMatchingImageRule(target);
    if (rule && rule.linkPattern) {
      const altText = Paster.getAltText(target);
      let link = rule.linkPattern;
      // linkPattern is already processed in getMatchingImageRule
      // Replace custom placeholders.
      link = link
        .replace(/\$\{imageFilePath\}/g, imageFilePath)
        .replace(/\$\{altText\}/g, altText);
      return link;
    }

    // Default: use image tag if width/height are specified.
    const imgTag = pasteImgContext.imgTag;
    if (imgTag) {
      return `<img src='${imageFilePath}' ${Paster.getDimensionProps(
        imgTag.width,
        imgTag.height
      )}/>`;
    }
    return `![${Paster.getAltText(target)}](${imageFilePath})`;
  }

  private static getDimensionProps(width: any, height: any) {
    const widthProp = width === undefined ? "" : `width='${width}'`;
    const heightProp = height === undefined ? "" : `height='${height}'`;
    return [widthProp, heightProp].join(" ").trim();
  }

  private static renderMdImageBase64(
    pasteImgContext: PasteImageContext
  ): string {
    if (
      !pasteImgContext.targetFile.fsPath ||
      !existsSync(pasteImgContext.targetFile.fsPath)
    ) {
      return;
    }

    let renderText = base64Encode(pasteImgContext.targetFile.fsPath);
    const imgTag = pasteImgContext.imgTag;
    if (imgTag) {
      renderText = `<img src='data:image/png;base64,${renderText}' ${Paster.getDimensionProps(
        imgTag.width,
        imgTag.height
      )}/>`;
    } else {
      renderText = `![](data:image/png;base64,${renderText})`;
    }

    const rmOptions: RmOptions = {
      recursive: true,
      force: true,
    };

    if (pasteImgContext.removeTargetFileAfterConvert) {
      rmSync(pasteImgContext.targetFile.fsPath, rmOptions);
    }

    return renderText;
  }

  public static renderMarkdownLink(
    pasteImgContext: PasteImageContext,
    target: PasteTarget
  ) {
    const editor = target.editor;
    if (!editor) return;
    let renderText: string;
    if (pasteImgContext.convertToBase64) {
      renderText = Paster.renderMdImageBase64(pasteImgContext);
    } else {
      renderText = Paster.renderMdFilePath(pasteImgContext, target);
    }

    if (renderText) {
      editor.edit((edit) => {
        const current = target.selection;
        if (current.isEmpty) {
          edit.insert(current.start, renderText);
        } else {
          edit.replace(current, renderText);
        }
      });
    }
  }

  /**
   * Encode path string.
   * encodeURI        : encode all characters to URL encode format
   * encodeSpaceOnly  : encode all space characters to %20
   * none             : do nothing
   * @param filePath
   * @returns
   */
  private static encodePath(
    filePath: string,
    editor = vscode.window.activeTextEditor
  ) {
    filePath = filePath.replace(/\\/g, "/");
    const encodePathConfig = Paster.getConfig(editor).encodePath;
    if (encodePathConfig == "encodeURI") {
      filePath = encodeURI(filePath);
    } else if (encodePathConfig == "encodeSpaceOnly") {
      filePath = filePath.replace(/ /g, "%20");
    }
    return filePath;
  }

  private static get_rules(languageId, editor: vscode.TextEditor) {
    let lang_rules = Paster.getConfig(editor).lang_rules;
    if (languageId === "markdown") {
      return Paster.getConfig(editor).rules;
    }
    for (const lang_rule of lang_rules) {
      if (lang_rule.hasOwnProperty(languageId)) {
        return lang_rule[languageId];
      }
    }
    return [];
  }

  /**
   * Parse content by rules.
   * @param content Content to parse.
   * @returns Replaced string if a rule matched; otherwise, the original content.
   */
  private static parse_rules(content, target: PasteTarget): string | null {
    const editor = target.editor;
    const languageId = editor.document.languageId;
    const config = Paster.getConfig(editor);
    const rules = Paster.get_rules(languageId, editor);
    const applyAllRules = config.applyAllRules;
    let isApplicable = false;
    for (const rule of rules) {
      const re = new RegExp(rule.regex, rule.options);
      const reps = Predefine.replacePredefinedVars(
        rule.replace,
        editor,
        target.selection
      );
      if (re.test(content)) {
        content = content.replace(re, reps);
        if (!applyAllRules) {
          return content;
        }
        isApplicable = true;
      }
    }
    return isApplicable ? content : null;
  }

  static parse(content, target: PasteTarget) {
    const editor = target.editor;
    const fileUri = editor.document.uri;
    const ret = Paster.parse_rules(content, target);
    if (typeof ret === "string") {
      return ret;
    }
    try {
      if (existsSync(content)) {
        const current_file_path = fileUri.fsPath;
        const workspace_root_dir =
          vscode.workspace.workspaceFolders &&
          vscode.workspace.workspaceFolders[0].uri.path;
        if (content.startsWith(workspace_root_dir)) {
          const relative_path = Paster.encodePath(
            path.relative(path.dirname(current_file_path), content),
            editor
          );
          return `![${Paster.getAltText(target)}](${relative_path})`;
        }
      }
    } catch (error) {
      // Do nothing.
    }
    return content;
  }

  /**
   * Download image from URL and render Markdown link.
   * @param image_url
   */
  private static pasteImageURL(image_url, target: PasteTarget) {
    const filename = image_url.split("/").pop().split("?")[0];
    const ext = path.extname(filename);
    let imagePath = Paster.genTargetImagePath(target, ext);
    if (!imagePath) return;
    const silence = Paster.getConfig(target.editor).silence;
    if (silence) {
      Paster.downloadFile(image_url, imagePath, target);
    } else {
      const options: vscode.InputBoxOptions = {
        prompt:
          "You can change the filename. The existing file will be overwritten!",
        value: imagePath,
        placeHolder: "(e.g:../test/myimg.png?100,60)",
        valueSelection: [
          imagePath.length - path.basename(imagePath).length,
          imagePath.length - ext.length,
        ],
      };
      vscode.window.showInputBox(options).then((inputVal) => {
        if (inputVal) Paster.downloadFile(image_url, inputVal, target);
      });
    }
  }

  private static downloadFile(
    image_url: string,
    targetPath: string,
    target: PasteTarget
  ) {
    const pasteImgContext = Paster.parsePasteImageContext(
      targetPath,
      target.editor,
      target.selection
    );
    if (!pasteImgContext || !pasteImgContext.targetFile) return;
    const imgPath = pasteImgContext.targetFile.fsPath;
    if (!prepareDirForFile(imgPath)) {
      vscode.window.showErrorMessage("Make folder failed:" + imgPath);
      return;
    }
    fetchAndSaveFile(image_url, imgPath)
      .then((imagePath: string) => {
        if (!imagePath) return;
        if (imagePath === "no image") {
          vscode.window.showInformationMessage(
            "There is not an image in the clipboard."
          );
          return;
        }
        if (imagePath.substring(1, 2) === ":") {
          imagePath = "file:///" + imagePath;
        }
        pasteImgContext.targetFile = vscode.Uri.parse(imagePath);
        Paster.renderMarkdownLink(pasteImgContext, target);
      })
      .catch((err) => {
        vscode.window.showErrorMessage("Download failed:" + err);
      });
  }

  /**
   * Paste clipboard image to file and render Markdown link.
   */
  private static pasteImage(target: PasteTarget) {
    const ext = ".png";
    let imagePath = Paster.genTargetImagePath(target, ext);
    if (!imagePath) return;
    const silence = Paster.getConfig(target.editor).silence;
    if (silence) {
      Paster.saveImage(imagePath, target);
    } else {
      const options: vscode.InputBoxOptions = {
        prompt:
          "You can change the filename. The existing file will be overwritten!",
        value: imagePath,
        placeHolder: "(e.g:../test/myimage.png?100,60)",
        valueSelection: [
          imagePath.length - path.basename(imagePath).length,
          imagePath.length - ext.length,
        ],
      };
      vscode.window.showInputBox(options).then((inputVal) => {
        if (inputVal) Paster.saveImage(inputVal, target);
      });
    }
  }

  /**
   * Save the image from the clipboard and insert the Markdown link.
   * @param targetPath
   */
  protected static async saveImage(targetPath: string, target: PasteTarget) {
    const pasteImgContext = Paster.parsePasteImageContext(
      targetPath,
      target.editor,
      target.selection
    );
    if (!pasteImgContext || !pasteImgContext.targetFile) return;
    const imgPath = pasteImgContext.targetFile.fsPath;
    if (!prepareDirForFile(imgPath)) {
      vscode.window.showErrorMessage("Make folder failed:" + imgPath);
      return;
    }
    const shell = xclip.getShell();
    const cb = shell.getClipboard();
    const imagePath = await Paster.getClipboardImage(shell, cb, imgPath);
    if (!imagePath) return;
    if (imagePath === "no image") {
      vscode.window.showInformationMessage(
        "There is not an image in the clipboard."
      );
      return;
    }
    Paster.renderMarkdownLink(pasteImgContext, target);
  }

  /**
   * Generate a PasteImageContext from the input value.
   * The input can include query parameters for width and height.
   * @param inputVal
   * @returns PasteImageContext or null if invalid.
   */
  protected static parsePasteImageContext(
    inputVal: string,
    editor: vscode.TextEditor = vscode.window.activeTextEditor,
    selection: vscode.Selection = editor?.selection
  ): PasteImageContext | null {
    if (!inputVal) return;
    inputVal = Predefine.replacePredefinedVars(inputVal, editor, selection);
    if (inputVal && inputVal.length !== inputVal.trim().length) {
      vscode.window.showErrorMessage(
        'The specified path is invalid: "' + inputVal + '"'
      );
      return;
    }
    if (inputVal.substring(1, 2) === ":") {
      inputVal = "file:///" + inputVal;
    }
    const pasteImgContext = new PasteImageContext();
    const inputUri = vscode.Uri.parse(inputVal);
    const last_char = inputUri.fsPath.slice(-1);
    if (["/", "\\"].includes(last_char)) {
      pasteImgContext.targetFile = newTemporaryFilename();
      pasteImgContext.convertToBase64 = true;
      pasteImgContext.removeTargetFileAfterConvert = true;
    } else {
      pasteImgContext.targetFile = inputUri;
      pasteImgContext.convertToBase64 = false;
      pasteImgContext.removeTargetFileAfterConvert = false;
    }
    const enableImgTagConfig = Paster.getConfig(editor).enableImgTag;
    if (enableImgTagConfig && inputUri.query) {
      const ar = inputUri.query.split(",");
      if (ar) {
        pasteImgContext.imgTag = {
          width: ar[0],
          height: ar[1],
        };
      }
    }
    return pasteImgContext;
  }

  private static getAltText(target: PasteTarget): string {
    const selection = target.selection;
    const selectText = target.editor.document.getText(selection);
    return selectText;
  }
}

export { Paster };
