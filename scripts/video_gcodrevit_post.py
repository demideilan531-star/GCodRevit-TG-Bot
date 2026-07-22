#!/usr/bin/env python3
"""Analyze a Telegram video and publish an AI-written GCodRevit post."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request


TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"
TELEGRAM_FILE_API = "https://api.telegram.org/file/bot{token}/{file_path}"
GITHUB_MODELS_API = "https://models.github.ai/inference/chat/completions"
MAX_TELEGRAM_DOWNLOAD = 20 * 1024 * 1024
MAX_TRANSCRIPT_CHARS = 12_000
CAPTION_LIMIT = 1_000


class VideoPostError(RuntimeError):
    pass


def request_json(request: urllib.request.Request, timeout: int = 180) -> dict:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise VideoPostError(f"HTTP {exc.code}: {body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise VideoPostError(f"Network request failed: {exc.reason}") from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise VideoPostError(f"Service returned invalid JSON: {raw[:300]}") from exc


def telegram_json(token: str, method: str, payload: dict) -> dict:
    request = urllib.request.Request(
        TELEGRAM_API.format(token=token, method=method),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    result = request_json(request)
    if result.get("ok") is not True:
        raise VideoPostError(result.get("description") or f"Telegram {method} failed")
    return result


def download_telegram_video(token: str, file_id: str, target_dir: Path) -> Path:
    info = telegram_json(token, "getFile", {"file_id": file_id}).get("result", {})
    file_path = info.get("file_path")
    file_size = int(info.get("file_size") or 0)
    if not file_path:
        raise VideoPostError("Telegram did not return file_path for the video")
    if file_size > MAX_TELEGRAM_DOWNLOAD:
        raise VideoPostError("Video is larger than Telegram's 20 MB bot download limit")

    suffix = Path(file_path).suffix or ".mp4"
    target = target_dir / f"source{suffix}"
    request = urllib.request.Request(
        TELEGRAM_FILE_API.format(token=token, file_path=file_path),
        headers={"User-Agent": "GCodRevit-TG-Bot/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            with target.open("wb") as handle:
                while chunk := response.read(1024 * 1024):
                    handle.write(chunk)
                    if handle.tell() > MAX_TELEGRAM_DOWNLOAD:
                        raise VideoPostError("Downloaded video exceeded the 20 MB limit")
    except urllib.error.URLError as exc:
        raise VideoPostError(f"Could not download Telegram video: {exc.reason}") from exc

    if not target.exists() or target.stat().st_size == 0:
        raise VideoPostError("Telegram video download is empty")
    return target


def run_command(command: list[str], error_message: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        details = result.stderr.strip().splitlines()[-1:] or ["unknown error"]
        raise VideoPostError(f"{error_message}: {details[0]}")
    return result


def video_duration(video_path: Path) -> float:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        "ffprobe could not read the video",
    )
    try:
        return max(0.1, float(result.stdout.strip()))
    except ValueError as exc:
        raise VideoPostError("ffprobe returned an invalid video duration") from exc


def extract_frames(video_path: Path, target_dir: Path, duration: float) -> list[Path]:
    frames_dir = target_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    points = [0.08, 0.35, 0.65, 0.92]
    frames: list[Path] = []

    for index, ratio in enumerate(points, start=1):
        timestamp = min(max(duration * ratio, 0), max(duration - 0.1, 0))
        frame_path = frames_dir / f"frame-{index}.jpg"
        result = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-vf",
                "scale='min(640,iw)':-2",
                "-q:v",
                "5",
                str(frame_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode == 0 and frame_path.exists() and frame_path.stat().st_size:
            frames.append(frame_path)

    if not frames:
        raise VideoPostError("FFmpeg could not extract any frames from the video")
    return frames


def has_audio_stream(video_path: Path) -> bool:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(video_path),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def extract_audio(video_path: Path, target_dir: Path) -> Path | None:
    if not has_audio_stream(video_path):
        return None
    audio_path = target_dir / "audio.wav"
    run_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(audio_path),
        ],
        "FFmpeg could not extract the audio track",
    )
    return audio_path


def transcribe_audio(audio_path: Path | None, model_size: str) -> str:
    if audio_path is None:
        return "В видео нет звуковой дорожки."

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise VideoPostError("faster-whisper is not installed") from exc

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(
        str(audio_path),
        language="ru",
        vad_filter=True,
        beam_size=3,
    )
    transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    return transcript or "В видео нет разборчивой речи."


def shorten_transcript(text: str) -> str:
    text = " ".join(text.split())
    if len(text) <= MAX_TRANSCRIPT_CHARS:
        return text
    head = text[:8_000].rsplit(" ", 1)[0]
    tail = text[-3_500:].split(" ", 1)[-1]
    return f"{head}\n\n[середина расшифровки сокращена]\n\n{tail}"


def image_content(frame_path: Path) -> dict:
    encoded = base64.b64encode(frame_path.read_bytes()).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {
            "url": f"data:image/jpeg;base64,{encoded}",
            "detail": "low",
        },
    }


def model_request(github_token: str, model: str, messages: list[dict]) -> str:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.25,
        "max_tokens": 900,
    }
    request = urllib.request.Request(
        GITHUB_MODELS_API,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {github_token}",
            "Content-Type": "application/json",
            "User-Agent": "GCodRevit-TG-Bot/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        method="POST",
    )
    result = request_json(request, timeout=240)
    choices = result.get("choices") or []
    if not choices:
        raise VideoPostError("GitHub Models returned no choices")
    content = choices[0].get("message", {}).get("content", "")
    if isinstance(content, list):
        content = "\n".join(
            str(item.get("text", "")) for item in content if isinstance(item, dict)
        )
    content = str(content).strip()
    if not content:
        raise VideoPostError("GitHub Models returned an empty post")
    return content


def generate_post(
    github_token: str,
    model: str,
    instructions: str,
    source_caption: str,
    transcript: str,
    frames: list[Path],
) -> str:
    context = (
        "Подпись автора к исходному видео:\n"
        f"{source_caption or 'Не указана.'}\n\n"
        "Расшифровка речи:\n"
        f"{shorten_transcript(transcript)}\n\n"
        "Ниже приложены ключевые кадры по ходу видео."
    )
    multimodal_content = [{"type": "text", "text": context}]
    multimodal_content.extend(image_content(frame) for frame in frames)
    messages = [
        {"role": "system", "content": instructions},
        {"role": "user", "content": multimodal_content},
    ]

    try:
        return model_request(github_token, model, messages)
    except VideoPostError as vision_error:
        if "нет разборчивой речи" in transcript.lower() and not source_caption:
            raise VideoPostError(
                f"The model could not analyze frames and there is no transcript: {vision_error}"
            ) from vision_error
        print(f"Vision request failed; retrying with text only: {vision_error}")
        text_messages = [
            {"role": "system", "content": instructions},
            {
                "role": "user",
                "content": context + "\n\nКадры недоступны; опирайся только на подтверждённый текст.",
            },
        ]
        return model_request(github_token, model, text_messages)


def clean_caption(text: str) -> str:
    text = text.strip()
    if text.startswith("```") and text.endswith("```"):
        lines = text.splitlines()[1:-1]
        text = "\n".join(lines).strip()
    if len(text) <= CAPTION_LIMIT:
        return text
    shortened = text[: CAPTION_LIMIT - 1].rsplit("\n", 1)[0].rstrip()
    if len(shortened) < 600:
        shortened = text[: CAPTION_LIMIT - 1].rsplit(" ", 1)[0].rstrip()
    return shortened + "…"


def publish_video(token: str, chat_id: str, file_id: str, caption: str) -> int:
    payload = telegram_json(
        token,
        "sendVideo",
        {
            "chat_id": chat_id,
            "video": file_id,
            "caption": clean_caption(caption),
            "supports_streaming": True,
        },
    )
    result = payload.get("result", {})
    if not result.get("video"):
        raise VideoPostError("Telegram accepted the message but returned no video")
    return int(result["message_id"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a GCodRevit post from a Telegram video")
    parser.add_argument("--prompt", default="prompts/video-gcodrevit.md")
    return parser.parse_args()


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise VideoPostError(f"Required environment variable {name} is not set")
    return value


def main() -> int:
    args = parse_args()
    telegram_token = required_env("TELEGRAM_BOT_TOKEN")
    telegram_chat_id = required_env("TELEGRAM_CHAT_ID")
    telegram_file_id = required_env("TELEGRAM_FILE_ID")
    github_token = required_env("GITHUB_TOKEN")
    source_caption = os.environ.get("SOURCE_CAPTION", "").strip()
    model = os.environ.get("VIDEO_MODEL", "openai/gpt-4.1-mini").strip()
    whisper_model = os.environ.get("WHISPER_MODEL_SIZE", "base").strip()
    prompt_path = Path(args.prompt)
    if not prompt_path.is_file():
        raise VideoPostError(f"Prompt file does not exist: {prompt_path}")
    instructions = prompt_path.read_text(encoding="utf-8").strip()

    with tempfile.TemporaryDirectory(prefix="gcodrevit-video-") as temp_name:
        temp_dir = Path(temp_name)
        video_path = download_telegram_video(telegram_token, telegram_file_id, temp_dir)
        duration = video_duration(video_path)
        frames = extract_frames(video_path, temp_dir, duration)
        audio_path = extract_audio(video_path, temp_dir)
        transcript = transcribe_audio(audio_path, whisper_model)
        post = generate_post(
            github_token,
            model,
            instructions,
            source_caption,
            transcript,
            frames,
        )
        message_id = publish_video(
            telegram_token,
            telegram_chat_id,
            telegram_file_id,
            post,
        )

    print(
        f"Published video post. message_id={message_id}, model={model}, "
        f"duration={duration:.1f}s, caption_chars={len(clean_caption(post))}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VideoPostError as exc:
        print(f"Video post failed: {exc}")
        raise SystemExit(1)
