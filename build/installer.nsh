; ZTerm - 自定义 NSIS 安装/卸载脚本
; Tauri installerHooks 自动 include 此文件
;
; 设计目标：
; - 覆盖安装（${isUpdated} = true，或 ${Silent} = true）：保留 $INSTDIR\data\ 不删
;   让用户升级后配置（SSH profiles / 快捷键 / 高亮 / 标签）继续可用
; - 主动卸载（${Silent} = false）：弹窗问用户"是否同时删除配置数据？"
;   默认 uninstall 段不会主动删 install 时没创建的 data\，所以只在用户主动要求时才删

!macro customUnInstall
  ; ${Silent} 在覆盖安装时为 true（NSIS 传 /S 参数），主动卸载时为 false
  ${IfNot} ${Silent}
    ${If} ${FileExists} "$INSTDIR\data"
      MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除配置数据（SSH profiles / 快捷键 / 高亮 / 标签）？$\r$\n选 No 将保留以便后续重装。" IDNO skipDataDelete
      RMDir /r "$INSTDIR\data"
      skipDataDelete:
    ${EndIf}
  ${EndIf}
!macroend
