; build/installer.nsh - spawn's one-click Windows installer (electron-builder NSIS,
; package.json build.nsis). It does what scripts/install-local.cmd does for a local
; build: close spawn, put it in %LOCALAPPDATA%\spawn, make the shortcuts, start it.

; Where spawn has always lived (install-local.cmd, the zip instructions), not
; electron-builder's %LOCALAPPDATA%\Programs\spawn: run over a copy installed from
; the zip, the installer upgrades it in place. /D=<folder> still chooses another.
!macro customInit
  ${StdUtils.GetParameter} $R0 "D" ""
  ${If} $R0 == ""
    StrCpy $INSTDIR "$LOCALAPPDATA\spawn"
  ${EndIf}
!macroend

; Close a running spawn without asking, as install-local.cmd does (taskkill /F):
; spawn lives on in the tray, so a polite close is not enough. Claudex.exe is the
; name it had until 1.3.35 (an install updated from then may still run it). Used by
; the uninstaller too.
!macro customCheckAppRunning
  StrCpy $R9 "0"
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im spawn.exe /fi "USERNAME eq %USERNAME%"`
  Pop $R8
  ${If} $R8 == "0"
    StrCpy $R9 "1"
  ${EndIf}
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im Claudex.exe /fi "USERNAME eq %USERNAME%"`
  Pop $R8
  ${If} $R8 == "0"
    StrCpy $R9 "1"
  ${EndIf}
  ; let Windows let go of its files before they are replaced
  ${If} $R9 == "1"
    Sleep 3000
  ${EndIf}
!macroend

; The Desktop and Start menu shortcuts, made as scripts/desktop-shortcut.ps1 makes
; them (package.json turns electron-builder's own off): "spawn", opening spawn.exe
; from its folder, showing the icon file app updates replace (electron/shortcutIcon.cjs
; keeps them pointed at it). electron-builder's would also carry the appId as an
; AppUserModelID, which the app's window does not use (electron/ never sets one).
!macro customInstall
  StrCpy $R7 "$INSTDIR\resources\app\electron\assets\icon.ico"
  ${IfNot} ${FileExists} "$R7"
    StrCpy $R7 "$appExe"
  ${EndIf}
  SetOutPath "$INSTDIR"
  CreateShortCut "$DESKTOP\spawn.lnk" "$appExe" "" "$R7" 0 "" "" "spawn"
  CreateShortCut "$SMPROGRAMS\spawn.lnk" "$appExe" "" "$R7" 0 "" "" "spawn"
  ClearErrors
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

; Uninstalling removes them; the uninstall a newer installer runs first (--updated) leaves them
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Delete "$DESKTOP\spawn.lnk"
    Delete "$SMPROGRAMS\spawn.lnk"
  ${EndIf}
!macroend
