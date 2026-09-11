; Embed the helper in both installer and uninstaller: never execute a script
; from the installation directory, where an older release could replace it.
!define CLI_MANAGER_CLEANUP_SCRIPT "${__FILEDIR__}\cleanup.ps1"

; Tauri's built-in check kills by process NAME after the hooks, including
; another installation during silent updates. Our hooks already verify the
; exact installed paths, so suppress that second, unscoped termination.
!ifmacrodef CheckIfAppIsRunning
  !macroundef CheckIfAppIsRunning
  !macro CheckIfAppIsRunning executableName productName
  !macroend
!endif

!macro CLI_MANAGER_STOP_INSTALLED_PROCESSES
  InitPluginsDir
  File /oname=$PLUGINSDIR\cli-manager-cleanup.ps1 "${CLI_MANAGER_CLEANUP_SCRIPT}"
  StrCpy $1 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $1 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToLog /TIMEOUT=30000 '"$1" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cli-manager-cleanup.ps1" -InstallDirectory "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "CLI-Manager processes could not be stopped. Close CLI-Manager and retry. / 无法停止 CLI-Manager 进程，请退出应用后重试。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CLI_MANAGER_STOP_INSTALLED_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CLI_MANAGER_STOP_INSTALLED_PROCESSES
!macroend
