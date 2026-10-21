; NOVA Host: lo que se instala en el PC de juegos para jugar desde la tele.
;   - NovaBridge (bandeja): habla con NOVA, lista y abre los juegos.
;   - Sunshine (si falta): emite la imagen a Moonlight. Se deja configurado
;     para que NovaBridge escriba solo el PIN de Moonlight.
;   - ViGEmBus (si falta): el driver con el que el mando de la tele aparece
;     en el PC como un mando de Xbox o PlayStation.
; Lo construye scripts/host.ps1 (que pasa VERSION, BRIDGE, SUNSHINE, VIGEM, ICON, OUTFILE).

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define PRODUCT "NOVA Host"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NOVA Host"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\NOVA Host"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "NOVA TV"
ShowInstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1034 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1034 "FileDescription" "Instalador de NOVA Host"
VIAddVersionKey /LANG=1034 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1034 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1034 "LegalCopyright" "NOVA TV"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Juega en la tele a los juegos de este PC"
!define MUI_WELCOMEPAGE_TEXT "NOVA Host prepara este PC para que NOVA TV juegue a sus juegos desde la tele, por la red de casa.$\r$\n$\r$\nSe instalan:$\r$\n  •  NovaBridge, que se queda junto al reloj y habla con la tele.$\r$\n  •  Sunshine, que envía la imagen (si no lo tienes ya).$\r$\n  •  El driver de mandos ViGEmBus, para que el mando de la tele funcione en los juegos.$\r$\n$\r$\nLa tele necesita Moonlight; NOVA te lo indica en Ajustes → Juegos desde tu PC."
!define MUI_FINISHPAGE_TITLE "Este PC ya está listo"
!define MUI_FINISHPAGE_TEXT "En la tele, abre NOVA → Ajustes → Juegos desde tu PC → Buscar PCs.$\r$\n$\r$\nCuando la tele lo pida, pulsa «Sí» en este PC. Mejor con cable de red."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Abrir NovaBridge ahora"
!define MUI_FINISHPAGE_RUN_FUNCTION StartBridge

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSES}"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "NOVA Host necesita Windows de 64 bits."
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

; Opened through Explorer so NovaBridge runs as the user, not as administrator.
Function StartBridge
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\NovaBridge.exe"'
FunctionEnd

Section "NOVA Host"
  SetShellVarContext all
  DetailPrint "Cerrando NovaBridge si estaba abierto…"
  nsExec::Exec 'taskkill /IM NovaBridge.exe /F'

  SetOutPath "$INSTDIR"
  File "/oname=NovaBridge.exe" "${BRIDGE}"
  File "/oname=LICENCIAS.txt" "${LICENSES}"

  ; Gamepad driver first, so Sunshine finds it when it starts.
  nsExec::Exec 'sc query ViGEmBus'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Instalando el driver de mandos (ViGEmBus)…"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=vigembus-setup.exe" "${VIGEM}"
    ExecWait '"$PLUGINSDIR\vigembus-setup.exe" /exenoui /qn /norestart' $0
    SetOutPath "$INSTDIR"
    ${If} $0 == 3010
      DetailPrint "Driver de mandos instalado (Windows pide reiniciar para terminar)"
      SetRebootFlag true
    ${ElseIf} $0 != 0
      DetailPrint "El driver de mandos no se pudo instalar (código $0)"
      MessageBox MB_ICONEXCLAMATION "El driver de mandos (ViGEmBus) no se pudo instalar (código $0). Podrás jugar, pero el mando de la tele no llegará a los juegos."
    ${Else}
      DetailPrint "Driver de mandos instalado"
      ; A Sunshine already running looks for the driver only when it starts.
      nsExec::Exec 'net stop SunshineService'
      nsExec::Exec 'net start SunshineService'
    ${EndIf}
  ${Else}
    DetailPrint "El driver de mandos (ViGEmBus) ya estaba instalado"
  ${EndIf}

  ${IfNot} ${FileExists} "$PROGRAMFILES64\Sunshine\sunshine.exe"
    DetailPrint "Instalando Sunshine (puede tardar un minuto)…"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=sunshine.msi" "${SUNSHINE}"
    ExecWait 'msiexec /i "$PLUGINSDIR\sunshine.msi" /qn /norestart' $0
    SetOutPath "$INSTDIR"
    ${If} $0 != 0
    ${AndIf} $0 != 3010
      DetailPrint "Sunshine no se pudo instalar (código $0)"
      MessageBox MB_ICONEXCLAMATION "Sunshine no se pudo instalar (código $0). NovaBridge funcionará, pero sin imagen hasta que instales Sunshine desde lizardbyte.dev."
    ${EndIf}
  ${Else}
    DetailPrint "Sunshine ya estaba instalado: se respeta su configuración"
  ${EndIf}

  DetailPrint "Configurando el cortafuegos, Sunshine y el arranque con Windows…"
  ExecWait '"$INSTDIR\NovaBridge.exe" --setup'

  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  CreateShortcut "$SMPROGRAMS\NovaBridge.lnk" "$INSTDIR\NovaBridge.exe"

  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "NOVA TV"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\NovaBridge.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext all
  nsExec::Exec 'taskkill /IM NovaBridge.exe /F'
  ExecWait '"$INSTDIR\NovaBridge.exe" --uninstall'
  Delete "$INSTDIR\NovaBridge.exe"
  Delete "$INSTDIR\LICENCIAS.txt"
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\NovaBridge.lnk"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  ; Sunshine stays: it has its own uninstaller in Windows' list of apps.
SectionEnd
