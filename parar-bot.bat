@echo off
title Parar Bot - Eleven Perfumaria
cd /d "%~dp0"
echo ============================================
echo Parando o bot (o staff sera avisado)...
echo ============================================
echo.
call pm2 stop whatsapp-bot
echo.
echo ============================================
echo Bot parado. Pode fechar esta janela quando quiser (clique no X).
echo ============================================
cmd /k
