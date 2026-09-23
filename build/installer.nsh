; ZTerm - custom NSIS install/uninstall script
; Included automatically by Tauri installerHooks
;
; Design goals:
; - Over-install/upgrade (${isUpdated} = true, or ${Silent} = true): keep
;   $INSTDIR\data\ so config (SSH profiles/shortcuts/highlights/tabs) survives
; - Explicit uninstall (${Silent} = false): ask whether to delete config data;
;   the default section never removes data\ (install did not create it)

!macro customUnInstall
  ; ${Silent} is true on over-install (NSIS passes /S) and false on explicit uninstall
  ${IfNot} ${Silent}
    ${If} ${FileExists} "$INSTDIR\data"
      MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除配置数据（SSH profiles / 快捷键 / 高亮 / 标签）？$\r$\n选 No 将保留以便后续重装。" IDNO skipDataDelete
      RMDir /r "$INSTDIR\data"
      skipDataDelete:
    ${EndIf}
  ${EndIf}
!macroend
