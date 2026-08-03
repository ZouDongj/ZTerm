; ZTerm NSIS 安装器钩子 (Tauri 2.11 NSIS_HOOK_* 宏)
; 清理旧版 Electron 运行时残留（保留 data/ 用户数据目录）

!macro NSIS_HOOK_PREINSTALL
  ; 清理旧版 Electron 运行时残留（Electron 专用文件，避免与 Tauri 版混装）
  ; 注意: 不删除 data/ 目录（可能是用户数据）
  ${If} ${FileExists} "$INSTDIR\resources"
    RMDir /r "$INSTDIR\resources"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\locales"
    RMDir /r "$INSTDIR\locales"
  ${EndIf}
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
!macroend
