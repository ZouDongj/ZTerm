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

; Per-machine data isolation: the default data dir lives in each account's
; Local AppData and is created by the application on first run. The installer
; never creates a data dir under $INSTDIR and never grants write access to it.
; Per-machine scope follows the installer's mode ($MultiUser.InstallMode),
; not the install path: an AllUsers install into a custom directory is
; covered, a CurrentUser install is skipped whatever its path.
; A legacy shared $INSTDIR\data (pre-created with a BUILTIN\Users modify grant
; by old installers) is kept (never deleted) but locked down so no account
; keeps writing shared state, while every account can still READ it once for
; the per-account seed. Two steps, both required:
;   1. /reset clears every explicit ACE in the tree (grant:r alone only
;      replaces grants for the SIDs it lists - a Modify grant to any other
;      SID, or a deny ACE, would survive);
;   2. /inheritance:r cuts inheritance from the install dir (a parent's
;      inheritable Users Modify must not survive - /inheritance:e would keep
;      it) and grants exactly: BUILTIN\Users (S-1-5-32-545) read+execute,
;      BUILTIN\Administrators (S-1-5-32-544) and SYSTEM (S-1-5-18) full
;      control. (OI)(CI) is intentionally omitted: combined with /T the
;      flags make icacls leave FILES with an empty DACL (verified on a real
;      fixture); without them every dir and file gets the explicit ACE set.
; Any icacls failure aborts the install: a silent success would leave the
; permissive ACL in place.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $MultiUser.InstallMode == "AllUsers"
    ${If} ${FileExists} "$INSTDIR\data"
      nsExec::ExecToLog 'icacls "$INSTDIR\data" /reset /T /C /Q'
      Pop $0
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Failed to reset permissions on $INSTDIR\data (icacls exit code $0).$\r$\n$\r$\nThe legacy shared data directory keeps its permissive access; the installation will abort."
        Abort "could not reset the ACL of $INSTDIR\data"
      ${EndIf}
      nsExec::ExecToLog 'icacls "$INSTDIR\data" /inheritance:r /grant:r "*S-1-5-32-545:(RX)" /grant:r "*S-1-5-32-544:(F)" /grant:r "*S-1-5-18:(F)" /T /C /Q'
      Pop $0
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Failed to restrict permissions on $INSTDIR\data (icacls exit code $0).$\r$\n$\r$\nThe legacy shared data directory keeps its permissive access; the installation will abort."
        Abort "could not restrict the ACL of $INSTDIR\data"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
