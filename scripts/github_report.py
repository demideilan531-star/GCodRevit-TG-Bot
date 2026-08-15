import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont


TIMEZONE = ZoneInfo(os.getenv("REPORT_TIMEZONE", "Europe/Moscow"))
IMAGE_PATH = Path(os.getenv("GITHUB_IMAGE_PATH", "/tmp/github_report.png"))
CAPTION_PATH = Path(os.getenv("GITHUB_CAPTION_PATH", "/tmp/github_caption.txt"))

BACKGROUND = "#08131f"
PANEL = "#10263a"
PANEL_ALT = "#123451"
INK = "#f5f7fa"
MUTED = "#9fb2c3"
CYAN = "#4cb7e8"
GREEN = "#58d49b"
CORAL = "#ff755f"
YELLOW = "#ffc857"
PURPLE = "#9d82ff"

STATUS_LABELS = {
    "available": "УЖЕ ДОСТУПНО",
    "new": "НОВОЕ",
    "updated": "ОБНОВЛЕНО",
    "fixed": "ИСПРАВЛЕНО",
    "removed": "УБРАНО",
}
STATUS_COLORS = {
    "available": CYAN,
    "new": GREEN,
    "updated": PURPLE,
    "fixed": YELLOW,
    "removed": CORAL,
}
JOKES = (
    "Кнопки уже на месте. Инструкцию тоже догнали.",
    "Можно было написать «много кода». Но людям всё-таки нужны ответы.",
    "Репозиторий переведён с технического на человеческий.",
    "Цифры оставили разработчикам. Пользователям досталась польза.",
)


def load_report():
    raw = os.getenv("GITHUB_REPORT_JSON", "").strip()
    path = os.getenv("GITHUB_REPORT_JSON_PATH", "").strip()
    if path:
        raw = Path(path).read_text(encoding="utf-8")
    if not raw:
        raise RuntimeError("Не переданы данные GitHub-отчёта")
    report = json.loads(raw)
    if not isinstance(report, dict):
        raise RuntimeError("GitHub-отчёт должен быть JSON-объектом")
    return normalize_report(report)


def short_text(value, limit):
    value = " ".join(str(value or "").split())
    if len(value) <= limit:
        return value
    return value[: max(1, limit - 1)].rstrip() + "…"


def normalize_report(report):
    changes = []
    for item in report.get("changes", []):
        if not isinstance(item, dict):
            continue
        title = short_text(item.get("title"), 58)
        if not title:
            continue
        status = str(item.get("status") or "updated").lower()
        if status not in STATUS_LABELS:
            status = "updated"
        changes.append(
            {
                "status": status,
                "title": title,
                "what": short_text(item.get("what"), 120)
                or "Функция GCodRevit обновлена.",
                "how": short_text(item.get("how"), 125)
                or "Обнови GCod и продолжай работу как обычно.",
                "why": short_text(item.get("why"), 125)
                or "Чтобы рабочий сценарий был понятнее и стабильнее.",
            }
        )
    if not changes:
        changes = [
            {
                "status": "updated",
                "title": "Техническое обновление",
                "what": "Внутренняя часть GCodRevit обновлена.",
                "how": "Ничего переучивать не нужно: обнови GCod и работай как обычно.",
                "why": "Новых кнопок нет, но рабочий сценарий стал стабильнее.",
            }
        ]

    generated_at = str(report.get("generated_at") or "")
    try:
        generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00")).astimezone(TIMEZONE)
    except ValueError:
        generated = datetime.now(TIMEZONE)

    mode = "snapshot" if report.get("mode") == "snapshot" else "changes"
    return {
        "mode": mode,
        "variant": short_text(report.get("variant"), 24) or "default",
        "repository": short_text(report.get("repository"), 80) or "GCodRevit",
        "branch": short_text(report.get("branch"), 40) or "main",
        "generated": generated,
        "head_sha": short_text(report.get("head_sha"), 40),
        "title": short_text(report.get("report_title"), 72)
        or ("GCodRevit: что уже доступно" if mode == "snapshot" else "GCodRevit: что изменилось"),
        "summary": short_text(report.get("summary"), 165)
        or "Показываем изменения без технической бухгалтерии: только то, что полезно в работе.",
        "baseline_note": short_text(report.get("baseline_note"), 165),
        "changes": changes[:3],
    }


def font_path(bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    return next((path for path in candidates if Path(path).exists()), candidates[0])


def font(size, bold=False):
    return ImageFont.truetype(font_path(bold), size)


def wrap_lines(draw, text, selected_font, max_width, max_lines):
    words = str(text).split()
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=selected_font)[2] <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
        current = word
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        while lines[-1] and draw.textbbox((0, 0), lines[-1] + "…", font=selected_font)[2] > max_width:
            lines[-1] = lines[-1][:-1]
        lines[-1] += "…"
    return lines


def draw_wrapped(draw, xy, text, selected_font, fill, max_width, max_lines=2, spacing=5):
    lines = wrap_lines(draw, text, selected_font, max_width, max_lines)
    draw.multiline_text(xy, "\n".join(lines), font=selected_font, fill=fill, spacing=spacing)
    return len(lines)


def fitted_font(draw, text, max_width, start_size=29, min_size=20, bold=True):
    for size in range(start_size, min_size - 1, -1):
        selected = font(size, bold)
        if draw.textbbox((0, 0), str(text), font=selected)[2] <= max_width:
            return selected
    return font(min_size, bold)


def deterministic_joke(report):
    seed = f"{report['head_sha']}:{report['variant']}:{len(report['changes'])}"
    number = int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:8], 16)
    return JOKES[number % len(JOKES)]


def draw_labeled_row(draw, x, y, label, text, accent):
    draw.text((x, y), label, font=font(18, True), fill=accent)
    draw_wrapped(draw, (x + 112, y), text, font(18), INK, 900, 2, 4)


def draw_change_card(draw, y, change):
    accent = STATUS_COLORS[change["status"]]
    draw.rounded_rectangle((48, y, 1152, y + 238), radius=18, fill=PANEL)
    draw.rectangle((48, y, 56, y + 238), fill=accent)
    label = STATUS_LABELS[change["status"]]
    label_width = draw.textbbox((0, 0), label, font=font(15, True))[2] + 34
    draw.rounded_rectangle((78, y + 20, 78 + label_width, y + 54), radius=14, fill=PANEL_ALT)
    draw.text((95, y + 29), label, font=font(15, True), fill=accent)
    title_font = fitted_font(draw, change["title"], 1038 - label_width)
    draw.text((78 + label_width + 22, y + 22), change["title"], font=title_font, fill=INK)
    draw_labeled_row(draw, 78, y + 76, "ЧТО", change["what"], accent)
    draw_labeled_row(draw, 78, y + 132, "КАК", change["how"], CYAN)
    draw_labeled_row(draw, 78, y + 188, "ЗАЧЕМ", change["why"], GREEN)


def build_image(report):
    image = Image.new("RGB", (1200, 1200), BACKGROUND)
    draw = ImageDraw.Draw(image)
    generated = report["generated"]

    draw.text((48, 38), "GCODREVIT / GITHUB", font=font(27, True), fill=INK)
    draw.rounded_rectangle((938, 34, 1152, 76), radius=18, fill=PANEL_ALT)
    draw.text((1045, 55), "ДЛЯ ЧЕЛОВЕКА", font=font(16, True), fill=GREEN, anchor="mm")
    draw.line((48, 94, 1152, 94), fill="#24445e", width=2)

    draw_wrapped(draw, (48, 122), report["title"], font(43, True), INK, 1080, 2, 8)
    draw_wrapped(draw, (48, 184), report["summary"], font(21), MUTED, 1080, 2, 5)
    if report["baseline_note"]:
        draw.rounded_rectangle((48, 234, 1152, 298), radius=12, fill=PANEL_ALT)
        draw_wrapped(draw, (68, 246), report["baseline_note"], font(16), YELLOW, 1040, 2, 4)
    else:
        draw.text(
            (48, 248),
            f"Ветка {report['branch']} • {generated.strftime('%d.%m.%Y, %H:%M')} МСК",
            font=font(18),
            fill=MUTED,
        )

    start_y = 316
    for index, change in enumerate(report["changes"]):
        draw_change_card(draw, start_y + index * 254, change)

    draw.line((48, 1090, 1152, 1090), fill="#24445e", width=2)
    draw.text((48, 1115), deterministic_joke(report), font=font(18), fill=MUTED)
    draw.text((1152, 1150), "МЫ ЭТО РУКАМИ НЕ ДЕЛАЕМ", font=font(18, True), fill=GREEN, anchor="ra")

    IMAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    image.save(IMAGE_PATH, format="PNG", optimize=True)


def build_caption(report):
    generated = report["generated"]
    lines = [
        f"🧩 {report['title']}",
        f"🕒 {generated.strftime('%d.%m.%Y, %H:%M')} МСК",
        "",
        report["summary"],
    ]
    if report["baseline_note"]:
        lines.extend(["", f"ℹ️ {report['baseline_note']}"])
    for index, change in enumerate(report["changes"], 1):
        lines.extend(
            [
                "",
                f"{index}. {STATUS_LABELS[change['status']]}: {change['title']}",
                f"Как: {short_text(change['how'], 88)}",
                f"Зачем: {short_text(change['why'], 88)}",
            ]
        )
    lines.extend(["", deterministic_joke(report), "Мы это руками не делаем."])
    caption = "\n".join(lines)
    CAPTION_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAPTION_PATH.write_text(caption[:1024], encoding="utf-8")


def main():
    report = load_report()
    build_image(report)
    build_caption(report)
    print(f"GitHub report built: {len(report['changes'])} user-facing changes")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"GitHub report failed: {error}", file=sys.stderr)
        raise

