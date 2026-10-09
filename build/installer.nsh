; Extra steps of the Windows installer (electron-builder `nsis.include`).
;
; Register Letterdock as a candidate for mailto: links, so it appears in
; Windows Settings > Apps > Default apps. Windows keeps the choice with the user:
; nothing is taken over silently. Per-user (HKCU), like the one-click install itself.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Letterdock.Url.mailto" "" "URL:MailTo Protocol"
  WriteRegStr HKCU "Software\Classes\Letterdock.Url.mailto" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\Letterdock.Url.mailto\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Letterdock.Url.mailto\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Letterdock\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Letterdock\Capabilities" "ApplicationDescription" "Free email client with unlimited accounts"
  WriteRegStr HKCU "Software\Letterdock\Capabilities\URLAssociations" "mailto" "Letterdock.Url.mailto"
  WriteRegStr HKCU "Software\RegisteredApplications" "Letterdock" "Software\Letterdock\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Letterdock.Url.mailto"
  DeleteRegKey HKCU "Software\Letterdock\Capabilities"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Letterdock"
!macroend

; Robust updates: never abort because the OLD version's uninstaller could not run.
;
; electron-builder copies the previous uninstaller to a temp folder and runs it before installing.
; Windows Smart App Control (or a group policy, or antivirus) can block that unsigned copy. The
; stock template then shows an error and quits, which leaves the old version in place and the
; update stuck. Defining these two hooks REPLACES the stock result check (handleUninstallResult
; in installUtil.nsh): whatever the old uninstaller did, we clear the error and carry on. The new
; files are then written over the old ones in the same folder. User data in %APPDATA%\Letterdock is
; not touched either way. The new installer writes its own uninstaller and the Apps & features
; entry afterwards, so these point to the NEW version.
; Cost: the template tries up to 5 times with 1 second pauses before this check runs.
!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "Old uninstaller did not finish cleanly (code $R0). Installing over the existing files."
  ${endif}
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  ${if} $R0 != 0
    DetailPrint "Old uninstaller did not finish cleanly (code $R0). Installing over the existing files."
  ${endif}
  ClearErrors
!macroend
