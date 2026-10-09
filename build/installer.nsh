; Extra steps of the Windows installer (electron-builder `nsis.include`).
;
; Register Mailroom as a candidate for mailto: links, so it appears in
; Windows Settings > Apps > Default apps. Windows keeps the choice with the user:
; nothing is taken over silently. Per-user (HKCU), like the one-click install itself.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Mailroom.Url.mailto" "" "URL:MailTo Protocol"
  WriteRegStr HKCU "Software\Classes\Mailroom.Url.mailto" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\Mailroom.Url.mailto\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Mailroom.Url.mailto\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Mailroom\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Mailroom\Capabilities" "ApplicationDescription" "Free email client with unlimited accounts"
  WriteRegStr HKCU "Software\Mailroom\Capabilities\URLAssociations" "mailto" "Mailroom.Url.mailto"
  WriteRegStr HKCU "Software\RegisteredApplications" "Mailroom" "Software\Mailroom\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Mailroom.Url.mailto"
  DeleteRegKey HKCU "Software\Mailroom\Capabilities"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Mailroom"
!macroend
