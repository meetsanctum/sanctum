"""Exercise a fresh image through its Wyoming port."""

import json
import os
import socket
import sys
import time
import wave


def send(connection, event_type, data=None, payload=b""):
    body = json.dumps(data).encode() if data is not None else b""
    header = json.dumps(
        {"type": event_type, "data_length": len(body), "payload_length": len(payload)}
    )
    connection.sendall(header.encode() + b"\n" + body + payload)


def read_event(stream):
    event = json.loads(stream.readline())
    data = event.get("data", {})
    if event.get("data_length"):
        data.update(json.loads(stream.read(event["data_length"])))
    return event["type"], data


def receive(stream, expected_type, *, allow_onset=False):
    event_type, data = read_event(stream)
    if allow_onset and event_type == "voice-started":
        event_type, data = read_event(stream)
    if event_type != expected_type:
        raise RuntimeError(f"Expected {expected_type}, got {event_type}: {data}")
    return data


def wait_for_server():
    for _ in range(60):
        try:
            with socket.create_connection(("127.0.0.1", 10300), timeout=1) as conn:
                with conn.makefile("rb") as response:
                    send(conn, "describe")
                    info = receive(response, "info")
        except (OSError, json.JSONDecodeError):
            time.sleep(1)
            continue
        if not info["asr"] or info["asr"][0]["models"]:
            raise RuntimeError(f"Expected an untaught ASR service, got {info}")
        return
    raise RuntimeError("The server did not answer describe")


def main(lights_audio_path, undo_audio_path):
    wait_for_server()
    with socket.create_connection(("127.0.0.1", 10300), timeout=300) as conn:
        with conn.makefile("rb") as response:
            send(
                conn,
                "train",
                {
                    "token": os.environ["SANCTUM_TRAIN_TOKEN"],
                    "language": "en",
                    "templates": ["turn on the {room} lights", "undo [(that|it)]"],
                    "lists": {"room": ["kitchen"]},
                },
            )
            trained = receive(response, "trained")
            if not trained["changed"] or not trained["digest"]:
                raise RuntimeError(f"Expected the first lesson to load, got {trained}")

    expect_transcript(lights_audio_path, "turn on the kitchen lights")
    expect_transcript(undo_audio_path, "undo it")


def expect_transcript(audio_path, expected):
    with socket.create_connection(("127.0.0.1", 10300), timeout=60) as conn:
        with conn.makefile("rb") as response, wave.open(audio_path, "rb") as audio:
            audio_format = {
                "rate": audio.getframerate(),
                "width": audio.getsampwidth(),
                "channels": audio.getnchannels(),
            }
            send(conn, "audio-start", audio_format)
            send(conn, "audio-chunk", audio_format, audio.readframes(audio.getnframes()))
            send(conn, "audio-stop")

            transcript = receive(response, "transcript", allow_onset=True)
            if transcript["text"] != expected:
                raise RuntimeError(f"Expected transcript {expected!r}, got {transcript}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
