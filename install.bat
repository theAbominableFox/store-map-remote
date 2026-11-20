@echo off
REM ============================================================
REM  Instalator Mapy sklepow
REM  1. instaluje Pythona 3.12 przez winget (jesli go nie ma)
REM  2. instaluje biblioteke openpyxl
REM  Nie wymaga uprawnien administratora.
REM ============================================================
setlocal
cd /d "%~dp0"
echo === Mapa sklepow - instalacja ===
echo.

call :findpy
if defined PY (
  echo Python jest juz zainstalowany: %PY%
  goto :libs
)

echo Nie znaleziono Pythona - instaluje Python 3.12 przez winget...
where winget >nul 2>&1
if errorlevel 1 goto :nowinget
winget install --id Python.Python.3.12 --exact --scope user --silent --accept-package-agreements --accept-source-agreements
call :findpy
if not defined PY (
  echo.
  echo Python zostal zainstalowany, ale nie da sie go jeszcze uruchomic.
  echo Zamknij to okno i uruchom install.bat jeszcze raz ^(albo uruchom ponownie komputer^).
  goto :end
)
echo Python zainstalowany: %PY%

:libs
echo.
echo Instaluje biblioteki (openpyxl)...
%PY% -m pip install --user --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto :piperr
%PY% -c "import openpyxl" >nul 2>&1
if errorlevel 1 goto :piperr
echo.
echo Gotowe! Mape uruchamiasz plikiem start.bat
goto :end

:nowinget
echo.
echo Na tym komputerze nie ma programu winget.
echo Zainstaluj Pythona recznie: https://www.python.org/downloads/
echo  - w instalatorze zaznacz "Add python.exe to PATH"
echo Potem uruchom install.bat jeszcze raz.
goto :end

:piperr
echo.
echo Nie udalo sie zainstalowac biblioteki openpyxl - sprawdz polaczenie z internetem.
goto :end

:findpy
REM py launcher, python z PATH albo domyslna instalacja uzytkownika (pomija atrape z Microsoft Store)
set PY=
py -3 -c "import sys" >nul 2>&1 && set PY=py -3 && exit /b
python -c "import sys" >nul 2>&1 && set PY=python && exit /b
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set PY="%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
exit /b

:end
echo.
pause
