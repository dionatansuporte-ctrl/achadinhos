' OfertasDaHora - sobe API, worker e painel SEM abrir janela nenhuma.
' Clique duplo neste arquivo. A saida de cada processo vai para a pasta logs\.
' Para parar ou ligar junto com o Windows: OfertasDaHora.bat (na raiz).
' Uso avancado: cscript iniciar-oculto.vbs semweb  (nao sobe o painel web)

Option Explicit
Dim sh, fso, root, logs, semWeb
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logs = root & "\logs"
If Not fso.FolderExists(logs) Then fso.CreateFolder logs
semWeb = (WScript.Arguments.Count > 0 And LCase(WScript.Arguments(0)) = "semweb")

' 0 = janela oculta. True = espera terminar (so no docker, que e rapido).
sh.Run "cmd /c docker compose up -d >> """ & logs & "\docker.log"" 2>&1", 0, True

' Se ja estiver rodando, nao sobe de novo (evita duas APIs na mesma porta).
If Not JaRodando() Then
  sh.Run "cmd /c chcp 65001 >nul && cd /d """ & root & "\apps\api"" && npm run dev >> """ & logs & "\api.log"" 2>&1", 0, False
  sh.Run "cmd /c chcp 65001 >nul && cd /d """ & root & "\apps\api"" && npm run worker >> """ & logs & "\worker.log"" 2>&1", 0, False
  If Not semWeb Then
    sh.Run "cmd /c chcp 65001 >nul && cd /d """ & root & "\apps\web"" && npm run dev >> """ & logs & "\web.log"" 2>&1", 0, False
  End If
End If

' Aviso discreto na bandeja (some sozinho). Nao bloqueia.
sh.Popup "OfertasDaHora esta rodando em segundo plano." & vbCrLf & "Painel: http://127.0.0.1:8080" & vbCrLf & "Para parar, use OfertasDaHora.bat.", 6, "OfertasDaHora", 64

Function JaRodando()
  Dim wmi, procs, p
  JaRodando = False
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='node.exe'")
  For Each p In procs
    If Not IsNull(p.CommandLine) Then
      If InStr(p.CommandLine, "apps\api") > 0 And InStr(p.CommandLine, "server.ts") > 0 Then JaRodando = True
    End If
  Next
End Function
