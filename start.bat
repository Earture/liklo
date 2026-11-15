@echo off
rem liklo launcher - set NODE_EXE to any Node 22+ executable
rem (node:sqlite is required, so Node 22+ is a hard requirement)
set NODE_EXE=node
cd /d %~dp0
if not exist "%NODE_EXE%" (
  echo Node not found. Set NODE_EXE to a Node 22+ executable and retry.
  exit /b 1
)

rem drop artifacts of cancelled/errored jobs so a fresh run starts clean
"%NODE_EXE%" scripts\cleanup.js

rem read-only report library for other people, on its own port (default 3210)
start "liklo-public" "%NODE_EXE%" src\public-server.js

rem the working server (jobs, monitoring, editing) on port 3200
"%NODE_EXE%" src\server.js
