' 静默调用 watchdog.bat（0 = 隐藏窗口），供计划任务每 5 分钟触发
CreateObject("WScript.Shell").Run """C:\Users\EDY\.qclaw\workspace\kehu-auto\watchdog.bat""", 0, False
