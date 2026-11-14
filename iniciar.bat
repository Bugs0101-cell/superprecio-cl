@echo off
title SuperPrecio CL - Comparador de Supermercados
cd /d "%~dp0"
echo Iniciando SuperPrecio CL en http://localhost:3456 ...
start "" "http://localhost:3456"
node src/server.mjs
pause
