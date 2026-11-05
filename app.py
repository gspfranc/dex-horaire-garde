"""
DEX — Gestionnaire d'horaire de garde partagee.

Application Flask permettant de "tagger" chaque jour du calendrier a Oli ou Phil,
d'y ajouter une note libre, et de calculer automatiquement le nombre de jours
de garde de chacun. Lecture seule par defaut; edition apres authentification.
"""

from __future__ import annotations

import os
import secrets
from calendar import monthrange
from datetime import date, datetime, timedelta
from functools import wraps

from flask import (
    Flask,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

db = SQLAlchemy()

# --------------------------------------------------------------------------- #
#  Configuration des gardiens
# --------------------------------------------------------------------------- #

PEOPLE = {
    "Oli": {"label": "Oli", "color": "#2dd4bf"},
    "Phil": {"label": "Phil", "color": "#fbbf24"},
}

MONTH_NAMES = [
    "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]
MONTH_ABBR = [
    "Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin",
    "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc.",
]
# Les semaines commencent le dimanche.
# WEEK_START est l'indice Python du jour place en premiere colonne
# (lundi = 0, ... samedi = 5, dimanche = 6).
WEEK_START = 6

_DAY_ABBR_LUNDI = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]
DAY_ABBR = [_DAY_ABBR_LUNDI[(WEEK_START + i) % 7] for i in range(7)]

# Colonnes tombant sur un samedi ou un dimanche, pour la mise en evidence.
WEEKEND_COLUMNS = tuple(i for i in range(7) if (WEEK_START + i) % 7 >= 5)

NOTE_PRESETS = ["Vacances", "École", "Vétérinaire", "Toilettage", "Voyage", "Garderie"]


# --------------------------------------------------------------------------- #
#  Modele
# --------------------------------------------------------------------------- #

class DayEntry(db.Model):
    """Une journee du calendrier : a qui elle appartient + note libre."""

    __tablename__ = "day_entries"

    id = db.Column(db.Integer, primary_key=True)
    day = db.Column(db.Date, unique=True, nullable=False, index=True)
    owner = db.Column(db.String(32), nullable=True)
    note = db.Column(db.Text, nullable=True)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    def to_dict(self) -> dict:
        return {
            "date": self.day.isoformat(),
            "owner": self.owner,
            "note": self.note or "",
        }

    @property
    def is_empty(self) -> bool:
        return not self.owner and not (self.note or "").strip()


# --------------------------------------------------------------------------- #
#  Authentification
# --------------------------------------------------------------------------- #

def is_editor() -> bool:
    return bool(session.get("editor"))


def editor_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not is_editor():
            if request.path.startswith("/api/"):
                return jsonify(error="Authentification requise pour modifier."), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)

    return wrapper


# --------------------------------------------------------------------------- #
#  Helpers calendrier / statistiques
# --------------------------------------------------------------------------- #

def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def week_offset(day: date) -> int:
    """Rang de la journee dans sa semaine (0 = premiere colonne, le dimanche)."""
    return (day.weekday() - WEEK_START) % 7


def month_grid(year: int, month: int) -> list[list[date]]:
    """Grille de semaines completes (dimanche -> samedi) couvrant le mois."""
    first, last = month_bounds(year, month)
    cursor = first - timedelta(days=week_offset(first))
    end = last + timedelta(days=6 - week_offset(last))
    weeks: list[list[date]] = []
    current: list[date] = []
    while cursor <= end:
        current.append(cursor)
        if len(current) == 7:
            weeks.append(current)
            current = []
        cursor += timedelta(days=1)
    return weeks


def count_days(start: date | None = None, end: date | None = None) -> dict:
    """Nombre de jours tagges par personne sur un intervalle."""
    query = db.session.query(DayEntry.owner, db.func.count(DayEntry.id)).filter(
        DayEntry.owner.isnot(None)
    )
    if start is not None:
        query = query.filter(DayEntry.day >= start)
    if end is not None:
        query = query.filter(DayEntry.day <= end)

    counts = {name: 0 for name in PEOPLE}
    for owner, total in query.group_by(DayEntry.owner).all():
        if owner in counts:
            counts[owner] = total
    return counts


def scope_block(counts: dict, total_days: int | None = None) -> dict:
    """Bloc de statistiques pret a afficher pour une periode."""
    tagged = sum(counts.values())
    oli, phil = counts.get("Oli", 0), counts.get("Phil", 0)
    block = {
        "counts": counts,
        "tagged": tagged,
        "shares": {
            name: round(counts[name] / tagged * 100) if tagged else 0
            for name in PEOPLE
        },
        "gap": abs(oli - phil),
        "leader": "Oli" if oli > phil else ("Phil" if phil > oli else None),
    }
    if total_days is not None:
        block["total_days"] = total_days
        block["untagged"] = max(total_days - tagged, 0)
    return block


def build_stats(year: int, month: int) -> dict:
    first, last = month_bounds(year, month)
    jan1, dec31 = date(year, 1, 1), date(year, 12, 31)
    return {
        "month": scope_block(count_days(first, last), (last - first).days + 1),
        "year": scope_block(count_days(jan1, dec31), (dec31 - jan1).days + 1),
        "total": scope_block(count_days()),
    }


def entries_between(start: date, end: date) -> dict:
    rows = (
        DayEntry.query.filter(DayEntry.day >= start, DayEntry.day <= end)
        .order_by(DayEntry.day)
        .all()
    )
    return {row.day.isoformat(): row.to_dict() for row in rows}


def parse_iso(value: str) -> date:
    return datetime.strptime(value.strip(), "%Y-%m-%d").date()


def shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    index = (year * 12 + (month - 1)) + delta
    return index // 12, index % 12 + 1


# --------------------------------------------------------------------------- #
#  Fabrique d'application
# --------------------------------------------------------------------------- #

def create_app() -> Flask:
    app = Flask(__name__)

    data_dir = os.environ.get("DEX_DATA_DIR", os.path.join(app.root_path, "data"))
    os.makedirs(data_dir, exist_ok=True)

    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
        SQLALCHEMY_DATABASE_URI=os.environ.get(
            "DATABASE_URL", "sqlite:///" + os.path.join(data_dir, "dex.sqlite3")
        ),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        JSON_SORT_KEYS=False,
    )

    # Mot de passe d'edition : hash si fourni, sinon mot de passe en clair.
    password_hash = os.environ.get("EDIT_PASSWORD_HASH")
    if not password_hash:
        password_hash = generate_password_hash(os.environ.get("EDIT_PASSWORD", "dex"))
    app.config["EDIT_PASSWORD_HASH"] = password_hash

    db.init_app(app)
    with app.app_context():
        db.create_all()

    # ----------------------------- contexte -------------------------------- #

    @app.context_processor
    def inject_globals():
        today = date.today()
        return {
            "people": PEOPLE,
            "can_edit": is_editor(),
            "month_names": MONTH_NAMES,
            "month_abbr": MONTH_ABBR,
            "day_abbr": DAY_ABBR,
            "weekend_columns": WEEKEND_COLUMNS,
            "note_presets": NOTE_PRESETS,
            "today_iso": today.isoformat(),
            "today_year": today.year,
            "today_month": today.month,
        }

    # ------------------------------- vues ---------------------------------- #

    @app.route("/")
    def home():
        today = date.today()
        return redirect(url_for("month_view", year=today.year, month=today.month))

    @app.route("/mois/<int:year>/<int:month>")
    def month_view(year: int, month: int):
        if not 1 <= month <= 12 or not 1970 <= year <= 2200:
            today = date.today()
            return redirect(url_for("month_view", year=today.year, month=today.month))

        weeks = month_grid(year, month)
        entries = entries_between(weeks[0][0], weeks[-1][-1])
        prev_y, prev_m = shift_month(year, month, -1)
        next_y, next_m = shift_month(year, month, 1)

        return render_template(
            "month.html",
            year=year,
            month=month,
            weeks=weeks,
            entries=entries,
            stats=build_stats(year, month),
            prev=(prev_y, prev_m),
            next=(next_y, next_m),
            month_label="%s %s" % (MONTH_NAMES[month - 1], year),
        )

    @app.route("/annee/<int:year>")
    def year_view(year: int):
        if not 1970 <= year <= 2200:
            return redirect(url_for("year_view", year=date.today().year))

        months = []
        for m in range(1, 13):
            first, last = month_bounds(year, m)
            counts = count_days(first, last)
            months.append(
                {
                    "month": m,
                    "label": MONTH_NAMES[m - 1],
                    "weeks": month_grid(year, m),
                    "entries": entries_between(first, last),
                    "counts": counts,
                    "tagged": sum(counts.values()),
                    "days": (last - first).days + 1,
                }
            )

        jan1, dec31 = date(year, 1, 1), date(year, 12, 31)
        return render_template(
            "year.html",
            year=year,
            months=months,
            summary=scope_block(count_days(jan1, dec31), (dec31 - jan1).days + 1),
            overall=scope_block(count_days()),
        )

    @app.route("/login", methods=["GET", "POST"])
    def login():
        target = request.values.get("next") or url_for("home")
        if not target.startswith("/"):
            target = url_for("home")
        if is_editor():
            return redirect(target)

        if request.method == "POST":
            if check_password_hash(
                app.config["EDIT_PASSWORD_HASH"], request.form.get("password", "")
            ):
                session["editor"] = True
                session.permanent = True
                flash("Mode édition activé — bonne promenade !", "success")
                return redirect(target)
            flash("Mot de passe incorrect.", "error")

        return render_template("login.html", next_url=target)

    @app.post("/logout")
    def logout():
        session.pop("editor", None)
        flash("Retour en lecture seule.", "success")
        return redirect(request.referrer or url_for("home"))

    # -------------------------------- API ---------------------------------- #

    @app.get("/api/entries")
    def api_entries():
        try:
            start = parse_iso(request.args["start"])
            end = parse_iso(request.args["end"])
        except (KeyError, ValueError):
            return jsonify(error="Paramètres start et end (AAAA-MM-JJ) requis."), 400
        return jsonify(entries=entries_between(start, end))

    @app.get("/api/stats")
    def api_stats():
        today = date.today()
        try:
            year = int(request.args.get("year", today.year))
            month = int(request.args.get("month", today.month))
        except ValueError:
            return jsonify(error="Année ou mois invalide."), 400
        if not 1 <= month <= 12:
            return jsonify(error="Mois invalide."), 400
        return jsonify(stats=build_stats(year, month))

    def _read_dates(payload) -> list[date]:
        raw = payload.get("dates")
        if isinstance(raw, str):
            raw = [raw]
        if not isinstance(raw, list) or not raw:
            raise ValueError("Aucune date fournie.")
        if len(raw) > 400:
            raise ValueError("Trop de dates dans une seule requête (max 400).")
        try:
            return sorted({parse_iso(d) for d in raw})
        except (ValueError, TypeError, AttributeError):
            raise ValueError("Format de date invalide (attendu AAAA-MM-JJ).")

    @app.post("/api/entries")
    @editor_required
    def api_save_entries():
        payload = request.get_json(silent=True) or {}
        try:
            days = _read_dates(payload)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

        set_owner = "owner" in payload
        owner = payload.get("owner") or None
        if set_owner and owner is not None and owner not in PEOPLE:
            return jsonify(error="Gardien inconnu : %s" % owner), 400

        set_note = "note" in payload
        note = (payload.get("note") or "").strip()[:500] or None

        existing = {
            row.day: row for row in DayEntry.query.filter(DayEntry.day.in_(days)).all()
        }

        for day in days:
            row = existing.get(day)
            if row is None:
                if (set_owner and owner) or (set_note and note):
                    row = DayEntry(
                        day=day,
                        owner=owner if set_owner else None,
                        note=note if set_note else None,
                    )
                    db.session.add(row)
                continue
            if set_owner:
                row.owner = owner
            if set_note:
                row.note = note
            if row.is_empty:
                db.session.delete(row)

        db.session.commit()
        focus = days[0]
        return jsonify(
            entries=entries_between(days[0], days[-1]),
            stats=build_stats(focus.year, focus.month),
        )

    @app.delete("/api/entries")
    @editor_required
    def api_clear_entries():
        payload = request.get_json(silent=True) or {}
        try:
            days = _read_dates(payload)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

        DayEntry.query.filter(DayEntry.day.in_(days)).delete(synchronize_session=False)
        db.session.commit()
        focus = days[0]
        return jsonify(
            entries=entries_between(days[0], days[-1]),
            stats=build_stats(focus.year, focus.month),
        )

    @app.get("/healthz")
    def healthz():
        db.session.execute(db.text("SELECT 1"))
        return jsonify(status="ok", dog="DEX")

    # ------------------------------ erreurs -------------------------------- #

    @app.errorhandler(404)
    def not_found(_):
        return (
            render_template(
                "error.html",
                code=404,
                message="Cette page a été enterrée dans le jardin.",
            ),
            404,
        )

    @app.errorhandler(500)
    def server_error(_):
        db.session.rollback()
        return (
            render_template(
                "error.html", code=500, message="DEX a mâché un câble. Réessayez."
            ),
            500,
        )

    return app


app = create_app()


if __name__ == "__main__":
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5000")),
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
    )
