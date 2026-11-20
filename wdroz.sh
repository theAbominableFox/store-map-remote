#!/usr/bin/env bash
# Instalacja / aktualizacja Mapy sklepów na serwerze Ubuntu (Docker), kod z GitHuba.
#
#   bash wdroz.sh
#
# 1. instaluje git i Dockera, jeśli ich brak
# 2. pobiera najnowszy kod z prywatnego repozytorium (klucz "deploy key" tylko do odczytu, tworzony przy pierwszym
#    uruchomieniu – skrypt wypisze go i poczeka, aż zostanie dodany w GitHubie)
# 3. przy pierwszym uruchomieniu pyta o hasło do edycji i tworzy .env
# 4. buduje i uruchamia kontener (startuje sam po restarcie serwera)
#
# Dane (dane/), kopie (dane/kopie/), marka firmy (dane/marka/) i .env nie są w repozytorium – aktualizacja ich nie rusza.
# Logo/nazwę firmy: skopiuj folder "marka" (logo.png, favicon.png, nazwa.txt) do folderu aplikacji i uruchom skrypt.
set -euo pipefail

REPO="${MAPA_REPO:-git@github.com:theAbominableFox/store-map-remote.git}"
BRANCH="${MAPA_GALAZ:-main}"
KEY="$HOME/.ssh/mapa_sklepow_deploy"
SSH_CMD="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

# Całość w funkcji: bash wczytuje ją w całości, zanim "git pull" podmieni ten plik.
main() {
  cd "$(dirname "$(readlink -f "$0")")"

  echo "== Git"
  if ! command -v git >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y git
  fi
  if [ ! -f "$KEY" ]; then
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    ssh-keygen -q -t ed25519 -N "" -C "mapa-sklepow deploy $(hostname)" -f "$KEY"
  fi
  if ! GIT_SSH_COMMAND="$SSH_CMD" git ls-remote "$REPO" >/dev/null 2>&1; then
    echo
    echo "Serwer nie ma jeszcze dostępu do repozytorium. Dodaj ten klucz w GitHubie jako Deploy key (tylko do odczytu):"
    echo "  repozytorium → Settings → Deploy keys → Add deploy key"
    echo
    cat "$KEY.pub"
    echo
    printf "Czekam na dostęp"
    until GIT_SSH_COMMAND="$SSH_CMD" git ls-remote "$REPO" >/dev/null 2>&1; do printf "."; sleep 5; done
    echo " OK"
  fi
  if [ ! -d .git ]; then
    # pierwszy raz: zamień ten folder w kopię repozytorium (pliki ignorowane – dane/, .env – zostają)
    git init -q -b "$BRANCH"
    git remote add origin "$REPO"
  fi
  git config core.sshCommand "$SSH_CMD"
  git fetch -q origin "$BRANCH"
  if git rev-parse -q --verify HEAD >/dev/null; then
    if ! git diff --quiet HEAD -- || ! git diff --cached --quiet; then
      echo "Pliki aplikacji na serwerze zostały zmienione ręcznie:" >&2
      git status --short --untracked-files=no >&2
      echo "Cofnij zmiany (git checkout -- .) albo wprowadź je w repozytorium, i uruchom ponownie." >&2
      exit 1
    fi
    if git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
      git merge -q --ff-only "origin/$BRANCH"
    else
      # historia w GitHubie została przepisana (np. połączona w jeden commit) – pliki są czyste, więc przejdź na nią
      echo "Historia repozytorium w GitHubie została przepisana – przechodzę na aktualną wersję."
      git reset -q --hard "origin/$BRANCH"
    fi
  else
    git reset -q --hard "origin/$BRANCH"
    git branch -q -u "origin/$BRANCH"
  fi
  echo "Kod: $(git log -1 --format='%h %s (%cd)' --date=short)"

  echo "== Docker"
  if ! command -v docker >/dev/null 2>&1 || ! sudo docker compose version >/dev/null 2>&1; then
    echo "Instaluję Dockera (docker.io + docker-compose-v2)..."
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-v2
    sudo systemctl enable --now docker
  fi
  sudo docker compose version

  echo "== Dane"
  mkdir -p dane
  if [ ! -f dane/mapa_dane.xlsx ]; then
    if [ -f mapa_dane.xlsx ]; then
      mv mapa_dane.xlsx dane/mapa_dane.xlsx
    else
      echo "Brak pliku dane/mapa_dane.xlsx – skopiuj tam plik z danymi i uruchom ponownie." >&2
      exit 1
    fi
  elif [ -f mapa_dane.xlsx ]; then
    echo "dane/mapa_dane.xlsx już istnieje – NIE nadpisuję go (nowy plik zostaje jako mapa_dane.xlsx obok)."
  fi
  # marka firmy (logo.png, favicon.png, nazwa.txt) skopiowana do folderu aplikacji -> dane/marka (poza gitem)
  if [ -d marka ] && [ -n "$(ls -A marka)" ]; then
    sudo mkdir -p dane/marka
    sudo cp -f marka/* dane/marka/
    rm -rf marka
    echo "Marka firmy zainstalowana w dane/marka: $(ls dane/marka | tr '\n' ' ')"
  fi
  sudo chown -R 1000:1000 dane

  echo "== Ustawienia (.env)"
  if [ ! -f .env ]; then
    while true; do
      read -r -s -p "Ustal hasło do edycji mapy: " p1; echo
      read -r -s -p "Powtórz hasło: " p2; echo
      if [ -z "$p1" ]; then echo "Hasło nie może być puste."; continue; fi
      if [ "$p1" != "$p2" ]; then echo "Hasła się różnią, spróbuj jeszcze raz."; continue; fi
      case "$p1" in *"'"*) echo "Hasło nie może zawierać apostrofu ('), spróbuj jeszcze raz."; continue;; esac
      break
    done
    # pojedyncze cudzysłowy = docker compose bierze wartość dosłownie
    { grep -v '^MAPA_HASLO=' .env.example; printf "MAPA_HASLO='%s'\n" "$p1"; } > .env
    unset p1 p2
    chmod 600 .env
    echo ".env utworzony."
  else
    echo ".env już istnieje – zostawiam (hasło bez zmian)."
  fi

  echo "== Uruchamianie"
  sudo docker compose up -d --build
  echo "Czekam na start..."
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8000/api/version >/dev/null 2>&1; then
      echo
      echo "GOTOWE: mapa działa pod adresem  http://$(hostname -I | awk '{print $1}'):8000"
      exit 0
    fi
    sleep 1
  done
  echo "Serwer nie odpowiada – logi:" >&2
  sudo docker compose logs --tail 50
  exit 1
}

main "$@"
