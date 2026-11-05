# 🐾 DEX — Horaire de garde partagée

Application web pour gérer le calendrier de garde de **DEX**, partagé entre **Oli** et **Phil**.

- **Calendrier mensuel** où chaque journée est « taguée » à Oli ou Phil, avec une couleur distincte
- **Note libre** dans chaque case (« Vacances », « Vétérinaire », …)
- **Comptes automatiques** du nombre de jours de chacun : par mois, par année et au total, avec l'écart
- **Vue annuelle** : les 12 mois d'un coup d'œil avec les totaux
- **Lecture seule par défaut** — l'édition exige un mot de passe
- **Base de données SQLite** persistante
- **Prêt pour Docker**, avec volume pour conserver les données

---

## Démarrage rapide avec Docker

```bash
# 1. Choisir le mot de passe d'édition et une clé de session
cp .env.example .env          # puis éditez .env

# 2. Lancer
docker compose up -d --build
```

L'application est disponible sur **http://localhost:8080**.

> Sans fichier `.env`, le mot de passe d'édition par défaut est `dex`. **Changez-le.**

Commandes utiles :

```bash
docker compose logs -f        # suivre les journaux
docker compose restart        # redémarrer
docker compose down           # arrêter (les données sont conservées)
docker compose down -v        # arrêter ET supprimer les données
```

### Sans docker compose

```bash
docker build -t dex-horaire .
docker run -d --name dex \
  -p 8080:8080 \
  -e EDIT_PASSWORD="mon-mot-de-passe" \
  -e SECRET_KEY="$(python -c 'import secrets;print(secrets.token_hex(32))')" \
  -v dex-data:/data \
  dex-horaire
```

---

## Démarrage local (sans Docker)

Le plus simple — le script crée l'environnement virtuel au premier lancement :

```powershell
.\start.ps1                              # Windows, mot de passe « dex », port 5000
.\start.ps1 -Password secret -Port 8000
```

```bash
./start.sh                               # Linux / macOS
EDIT_PASSWORD=secret PORT=8000 ./start.sh
```

À la main :

```bash
python -m venv .venv
source .venv/bin/activate        # Windows : .venv\Scripts\activate
pip install -r requirements.txt

EDIT_PASSWORD=mon-mot-de-passe python app.py   # http://127.0.0.1:5000
```

Sous Windows (PowerShell) :

```powershell
$env:EDIT_PASSWORD = "mon-mot-de-passe"
python app.py
```

> `gunicorn` figure dans `requirements.txt` pour le conteneur Linux uniquement ;
> il ne s'importe pas sous Windows. En local, `python app.py` suffit.

---

## Utilisation

### Consulter

Tout le monde peut naviguer dans le calendrier, voir les couleurs, les notes et les
statistiques, **sans se connecter**. Le bandeau indique « Lecture seule ».

### Modifier

1. Cliquez sur **Se connecter** et entrez le mot de passe
2. La barre **Pinceau** apparaît au-dessus du calendrier

| Pinceau | Effet |
|---|---|
| **Détails** | Clic sur une journée → fiche complète (gardien + note + plage de dates) |
| **Oli** / **Phil** | Clic ou **glisser** sur plusieurs jours pour les attribuer d'un coup |
| **Effacer** | Clic ou glisser pour vider des journées |

Dans la fiche détaillée, le champ **« Appliquer jusqu'au »** applique le même
gardien et la même note à toute une plage (idéal pour une semaine de vacances).
Un clic n'importe où dans le champ ouvre le calendrier, et choisir une date active
la plage automatiquement — pas besoin de cocher la case à la main.

Le clavier fonctionne aussi : flèches pour se déplacer de case en case, `Entrée`
pour agir sur la journée sélectionnée, `Échap` pour fermer la fiche.

### Statistiques

Les totaux sont **annuels** : le panneau de droite affiche le bilan de l'année
affichée — nombre de jours de chacun, pourcentage, écart entre les deux et
nombre de journées encore non attribuées. Il n'y a volontairement pas de total
par mois : sur une garde partagée, c'est l'équilibre sur l'année qui compte.
Tout se recalcule à chaque modification.

La vue annuelle rappelle ce même bilan, avec le compte de chaque mois en vignette.

---

### Gérer la base de données

En mode édition, le bas du panneau de statistiques propose trois actions.

| Bouton | Effet |
|---|---|
| **Exporter** | Télécharge la base complète en un fichier `dex-AAAA-MM-JJ.sqlite3` |
| **Importer** | Charge un fichier `.sqlite3` et **remplace** l'horaire actuel |
| **Réinitialiser** | Efface tout l'historique et recrée une base vierge |

L'export est un instantané cohérent obtenu par l'API de sauvegarde de SQLite,
pas une copie brute du fichier : il reste fiable même si une écriture est en
cours. Le fichier obtenu se réimporte tel quel, ce qui en fait une sauvegarde
et un moyen de déplacer l'horaire d'une machine à l'autre.

Les deux actions destructrices sont protégées :

- **Importer** remplace les données, il ne fusionne pas. Le fichier déposé est
  traité comme une donnée non fiable : l'application vérifie qu'il s'agit bien
  d'une base SQLite saine contenant une table `day_entries` exploitable, et
  revalide chaque ligne (gardien connu, date valide, note tronquée à 500
  caractères). Un fichier qui ne convient pas est refusé avec un message
  explicite, sans toucher aux données existantes.
- **Réinitialiser** exige la saisie du mot `REINITIALISER` ; le bouton de
  suppression reste inactif tant que la phrase n'est pas exacte. Un simple clic
  ne peut donc pas effacer l'historique.

Pensez à exporter avant d'importer ou de réinitialiser.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `EDIT_PASSWORD` | `dex` | Mot de passe du mode édition |
| `EDIT_PASSWORD_HASH` | — | Empreinte Werkzeug, prioritaire sur `EDIT_PASSWORD` |
| `SECRET_KEY` | aléatoire au démarrage | Signature des sessions. **Fixez-la** pour que les sessions survivent à un redémarrage |
| `DATABASE_URL` | `sqlite:///<DEX_DATA_DIR>/dex.sqlite3` | Chaîne de connexion SQLAlchemy |
| `DEX_DATA_DIR` | `./data` (`/data` en conteneur) | Dossier de la base de données |
| `PORT` | `5000` en local, `8080` en conteneur | Port d'écoute |

Pour éviter de stocker le mot de passe en clair :

```bash
python -c "from werkzeug.security import generate_password_hash as h; print(h('mon-mot-de-passe'))"
# puis : EDIT_PASSWORD_HASH='scrypt:32768:8:1$...'
```

---

## Structure

```
dex/
├── app.py                   # application Flask : modèle, routes, API, statistiques
├── requirements.txt
├── Dockerfile               # image Python 3.12 slim + gunicorn, utilisateur non root
├── docker-compose.yml       # service + volume « dex-data »
├── start.ps1 / start.sh     # lancement local, crée le venv au besoin
├── .env.example
├── templates/
│   ├── base.html            # ossature, bandeau, pied de page
│   ├── month.html           # calendrier mensuel + statistiques + fiche d'édition
│   ├── year.html            # vue annuelle (12 mini-calendriers)
│   ├── login.html
│   ├── error.html
│   └── partials/
│       ├── sprite.svg       # symboles SVG (patte, tête de chien)
│       ├── paw.svg
│       └── dog.svg
├── static/
│   ├── css/style.css
│   ├── js/app.js            # pinceaux, peinture au glisser, fiche, statistiques
│   └── img/favicon.svg
└── data/                    # dossier versionne vide (.gitkeep) ; la base SQLite
                             # y est creee au premier demarrage, non versionnee
```

## API

Lecture publique, écriture réservée aux sessions authentifiées.

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/entries?start=AAAA-MM-JJ&end=AAAA-MM-JJ` | Journées d'un intervalle |
| `GET` | `/api/stats?year=2026` | Bilan de l'année (compteurs, parts, écart) |
| `POST` | `/api/entries` | Enregistrer — `{"dates": ["2026-11-10"], "owner": "Oli", "note": "Vacances"}` |
| `DELETE` | `/api/entries` | Vider — `{"dates": ["2026-11-10"]}` |
| `POST` | `/api/reset` | Vide et recrée la base — exige `{"confirm": "REINITIALISER"}` |
| `POST` | `/api/import` | Remplace les données par un fichier SQLite (`multipart/form-data`, champ `file`) |
| `GET` | `/export` | Télécharge la base en fichier `.sqlite3` |
| `GET` | `/healthz` | Sonde de santé (utilisée par Docker) |

`owner` accepte `"Oli"`, `"Phil"` ou `null`. Les champs absents de la charge utile
sont laissés inchangés : on peut donc changer le gardien sans toucher à la note.
Une journée dont le gardien **et** la note sont vides est supprimée de la base.

---

## Notes techniques

- **La base de données est créée automatiquement au premier démarrage** : le
  dossier de données et les tables sont mis en place au lancement, rien à
  initialiser à la main. Elle n'est pas versionnée (voir `.gitignore`).
- Une seule ligne par date (contrainte d'unicité) ; les compteurs sont des
  agrégats SQL `GROUP BY`, jamais des valeurs dénormalisées — ils ne peuvent pas
  se désynchroniser.
- Les journées portant seulement une note, sans gardien, ne sont comptées pour
  personne — pratique pour annoter un jour encore à répartir.
- Le mot de passe n'est jamais stocké en clair : seule son empreinte est gardée en
  mémoire, et les écritures passent par un décorateur `@editor_required`.
- Les semaines commencent le dimanche (constante `WEEK_START` dans `app.py`).
