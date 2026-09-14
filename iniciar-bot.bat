@echo off
title Iniciar Bot - Eleven Perfumaria
cd /d "%~dp0"
echo ============================================
echo Iniciando o bot...
echo ============================================
echo.
call pm2 start ecosystem.config.cjs
call pm2 save
echo.
echo ============================================
echo Bot iniciado! Pode fechar esta janela quando quiser (clique no X).
echo ============================================
cmd /k
