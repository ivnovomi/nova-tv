; NOVA TV's installer look (Tauri includes this file before defining its pages).
; Artwork: installer/art.html → scripts/installer-art.ps1 → sidebar.bmp / header.bmp.

; Light pages with NOVA's dark artwork on the side. (A dark background would
; hide the finish page's checkboxes: Windows draws their text in black, and
; Tauri's template leaves no way to fix them from here.)
!define MUI_HEADERIMAGE_RIGHT

!define MUI_WELCOMEPAGE_TITLE "Bienvenido a NOVA TV"
!define MUI_WELCOMEPAGE_TEXT "NOVA convierte este PC en una Smart TV: televisión en directo, tus juegos, YouTube y tus apps de streaming, todo con el mando.$\r$\n$\r$\nLa instalación tarda unos segundos y no necesita cuenta."
!define MUI_FINISHPAGE_TITLE "NOVA TV está lista"
!define MUI_FINISHPAGE_TEXT "Ya puedes abrir NOVA y disfrutarla en la tele.$\r$\n$\r$\nTruco: en Ajustes → Mando del móvil puedes usar tu teléfono como mando."
