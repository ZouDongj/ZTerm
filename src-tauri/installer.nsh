; ZTerm NSIS installer hooks (Tauri 2.11 NSIS_HOOK_* macros)
; Remove legacy Electron runtime leftovers (keep the data/ user data directory)

!macro NSIS_HOOK_PREINSTALL
  ; Remove legacy Electron runtime files (Electron-only, so the Tauri build never shares them)
  ; Note: do not delete the data/ directory (it may contain user data)
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

; Per-machine installs land in Program Files, where a normal user process
; cannot create <install dir>\data at runtime. The installer is elevated in
; that case, so pre-create the data dir and grant BUILTIN\Users modify.
; Per-user installs (%LOCALAPPDATA%) are skipped to keep the profile private.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $INSTDIR == "$PROGRAMFILES64\${PRODUCTNAME}"
  ${OrIf} $INSTDIR == "$PROGRAMFILES\${PRODUCTNAME}"
    CreateDirectory "$INSTDIR\data"
    nsExec::ExecToLog 'icacls "$INSTDIR\data" /grant "*S-1-5-32-545:(OI)(CI)(M)"'
  ${EndIf}
!macroend
