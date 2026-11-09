!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to TinyGPT"
  !define MUI_WELCOMEPAGE_TEXT "Set up TinyGPT on your computer.$\r$\n$\r$\nYour included local models download once when you first open the app. Future app updates keep them.$\r$\n$\r$\nChoose Next to get started."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ; Preserve matching model bytes from the previous installation before removal.
  ; The helper reads only catalog-listed model files and never uses the network.
  ${if} ${FileExists} "$INSTDIR\resources\work-runtimes\node\node.exe"
    InitPluginsDir
    File /oname=$PLUGINSDIR\tinygpt-models.cjs "${PROJECT_DIR}\scripts\migrate-model-assets.cjs"
    File /oname=$PLUGINSDIR\tinygpt-model-assets.json "${PROJECT_DIR}\build\model-assets.json"
    SetShellVarContext current
    nsExec::ExecToStack '"$INSTDIR\resources\work-runtimes\node\node.exe" "$PLUGINSDIR\tinygpt-models.cjs" "$INSTDIR\resources" "$APPDATA\TinyGPT Voice Clone\model-assets" "$PLUGINSDIR\tinygpt-model-assets.json"'
    Pop $0
    Pop $1
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend

!macro customHeader
  !define MUI_FINISHPAGE_TITLE "Make yourself at home."
  !define MUI_FINISHPAGE_TEXT "TinyGPT is installed.$\r$\n$\r$\nOpen the app for a short welcome, choose how you connect, and start your first conversation."
  !define MUI_FINISHPAGE_RUN_TEXT "Open TinyGPT"
!macroend
