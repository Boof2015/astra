!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; electron-builder declares the assisted directory page before this hook,
    ; then compiles installUtil.nsh and installSection.nsh afterward. Clear only
    ; the compile-time flag here so the picker remains available, but manual
    ; upgrades can use the built-in KeepShortcuts / --keep-shortcuts mechanism.
    ; Otherwise the old uninstaller unpins Astra and deletes its desktop link,
    ; and recreating that link loses its desktop position.
    ; The existing registry and target-executable checks still control whether
    ; shortcuts are preserved; a fresh install or move to an empty folder creates
    ; new links. A normal uninstall retains its usual shortcut cleanup.
    !ifdef allowToChangeInstallationDirectory
      !undef allowToChangeInstallationDirectory
    !endif
  !endif
!macroend
