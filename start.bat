@echo off
REM Uruchamia Mape sklepow. Opcjonalnie: start.bat sciezka\do\pliku.xlsx (albo .csv)
setlocal
cd /d "%~dp0"

call :findpy
if not defined PY (
  echo Nie znaleziono Pythona - uruchamiam instalacje...
  call "%~dp0install.bat"
  call :findpy
)
if not defined PY goto :fail

REM brakujace biblioteki
%PY% -c "import openpyxl" >nul 2>&1 || %PY% -m pip install --user --disable-pip-version-check -q -r requirements.txt || goto :fail

if "%~1"=="" (%PY% server.py mapa_dane.xlsx) else (%PY% server.py "%~1")
pause
exit /b

:findpy
set PY=
py -3 -c "import sys" >nul 2>&1 && set PY=py -3 && exit /b
python -c "import sys" >nul 2>&1 && set PY=python && exit /b
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set PY="%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
exit /b

:fail
echo.
echo Nie udalo sie uruchomic mapy. Uruchom install.bat i sprawdz komunikaty.
pause
exit /b 1
