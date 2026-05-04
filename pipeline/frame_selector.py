"""Best-frame extraction from a rack video.

Scans the video, scores each sampled frame using a tall-vertical-contour
heuristic (rack-shaped objects sitting roughly centered in the frame), and
returns the highest-scoring frame that also passes the same letterbox/tilt
checks the image pipeline uses.
"""

import cv2
import numpy as np

from pipeline.quality_check import check_letterbox, check_tilt

MIN_WIDTH = 640
MIN_HEIGHT = 480
FRAME_SKIP = 5
MAX_FRAMES = 400
TOP_K = 10


def _score_frame(frame):
    small = cv2.resize(frame, (640, 480))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    h, w = small.shape[:2]
    best = 0.0
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        if cw == 0 or ch / cw <= 2:
            continue
        height_coverage = ch / h
        center_offset = abs((x + cw / 2) - w / 2) / (w / 2)
        center_score = 1 - center_offset
        crop = gray[y:y + ch, x:x + cw]
        sharpness = cv2.Laplacian(crop, cv2.CV_64F).var() / 1000
        score = 0.5 * height_coverage + 0.3 * center_score + 0.2 * sharpness
        if score > best:
            best = score
    return best


def _passes_quality(frame):
    h, w = frame.shape[:2]
    if w < MIN_WIDTH or h < MIN_HEIGHT:
        return False
    if not check_letterbox(frame).get("ok"):
        return False
    if not check_tilt(frame).get("ok"):
        return False
    return True


def extract_best_frame(video_path):
    """Return the best BGR frame from the video, or None if unreadable."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None

    top = []
    frame_index = 0
    processed = 0
    try:
        while processed <= MAX_FRAMES:
            ret, frame = cap.read()
            if not ret:
                break
            frame_index += 1
            if frame_index % FRAME_SKIP != 0:
                continue
            score = _score_frame(frame)
            top.append((score, frame.copy()))
            top.sort(key=lambda t: t[0], reverse=True)
            top = top[:TOP_K]
            processed += 1
    finally:
        cap.release()

    if not top:
        return None

    for _score, frame in top:
        if _passes_quality(frame):
            return frame
    return top[0][1]
