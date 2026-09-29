property imageTypes : {{«class PNGf», ".png"}, {«class TIFF», ".tiff"}, {«class JPEG», ".jpg"}, {«class GIFf», ".gif"}}

on run argv
  if argv is {} then return ""

  set imagePath to item 1 of argv
  set imageType to getImageType()
  if imageType is not missing value then return saveClipboardImage(imagePath, imageType)

  set clipboardFilePath to getClipboardFilePath()
  if clipboardFilePath is missing value then
    copy "no image" to stdout
    return
  end if

  try
    do shell script "/usr/bin/sips -s format png " & quoted form of clipboardFilePath & " --out " & quoted form of imagePath
    copy imagePath to stdout
  on error
    return ""
  end try
end run

on saveClipboardImage(imagePath, imageType)
  set temporaryPath to imagePath & ".clipboard" & (second item of imageType)
  try
    set myFile to open for access POSIX file temporaryPath with write permission
    set eof myFile to 0
    write (the clipboard as (first item of imageType)) to myFile
    close access myFile

    if (first item of imageType) is not «class PNGf» then
      do shell script "/usr/bin/sips -s format png " & quoted form of temporaryPath & " --out " & quoted form of imagePath
      do shell script "/bin/rm -f " & quoted form of temporaryPath
    else
      do shell script "/bin/mv -f " & quoted form of temporaryPath & " " & quoted form of imagePath
    end if

    copy imagePath to stdout
  on error
    try
      close access myFile
    end try
    try
      do shell script "/bin/rm -f " & quoted form of temporaryPath
    end try
    return ""
  end try
end saveClipboardImage

on getImageType()
  repeat with imageType in imageTypes
    repeat with clipboardItem in (clipboard info)
      if (first item of clipboardItem) is equal to (first item of imageType) then
        return imageType
      end if
    end repeat
  end repeat
  return missing value
end getImageType

on getClipboardFilePath()
  repeat with clipboardItem in (clipboard info)
    if (first item of clipboardItem) is «class furl» then
      return POSIX path of (the clipboard as «class furl»)
    end if
  end repeat
  return missing value
end getClipboardFilePath
