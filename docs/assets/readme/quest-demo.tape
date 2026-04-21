Output docs/assets/readme/quest-demo.gif

Set Shell bash
Set FontSize 18
Set Width 1100
Set Height 720
Set Theme "TokyoNight"
Set Padding 16
Set Margin 20
Set MarginFill "#0b1020"
Set WindowBar Colorful
Set BorderRadius 8
Set TypingSpeed 30ms
Set CursorBlink false
Env QUEST_FORCE_INTERACTIVE "1"

Hide
Type "clear"
Enter
Show

Type "./bin/quest --pretty | sed -n '1,28p'"
Sleep 300ms
Enter
Sleep 2200ms
Screenshot docs/assets/readme/quest-demo.png
