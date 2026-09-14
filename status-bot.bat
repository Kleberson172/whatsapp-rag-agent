@echo off
title Status do Bot - Eleven Perfumaria
cd /d "%~dp0"
call pm2 status
echo.
echo ============================================
echo Pode fechar esta janela quando quiser (clique no X).
echo ============================================
cmd /k
