property clipboardTypeMappings : {{«class PNGf», "Image"}, {«class TIFF», "Image"}, {«class JPEG», "Image"}, {«class GIFf», "Image"}, {«class furl», "File"}, {«class HTML», "HTML"}, {«class utf8», "Text"}}

on run
  set detectedTypes to {}
  repeat with clipboardItem in (clipboard info)
    repeat with typeMapping in clipboardTypeMappings
      if (first item of clipboardItem) is equal to (first item of typeMapping) then
        set typeName to second item of typeMapping
        if detectedTypes does not contain typeName then
          set end of detectedTypes to typeName
        end if
      end if
    end repeat
  end repeat

  set output to ""
  repeat with typeName in detectedTypes
    if output is not "" then set output to output & linefeed
    set output to output & (contents of typeName)
  end repeat
  return output
end run
