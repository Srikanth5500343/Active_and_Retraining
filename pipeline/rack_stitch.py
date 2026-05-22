"""
Rack Image Stitcher — vertical multi-shot stitcher for tall racks.

Two entry points:
  1. Headless API:  stitch_images(paths, out_path) -> dict
       Called by server/app.js for the /api/stitch HTTP endpoint.
  2. CLI:           python -m pipeline.rack_stitch --inputs a.jpg b.jpg ... --output out.jpg
       Same path as the API, prints a JSON report on stdout.
  3. GUI (dev tool): python pipeline/rack_stitch.py
       Tkinter desktop wrapper for tuning / visual inspection.

Algorithm (find_overlap):
  - Convert both images to horizontal-edge maps (|d/dy| of luma). Rack imagery is
    full of uniform dark regions where raw-pixel comparison flat-lines; edges
    highlight cable rows / panel borders / LED strips that are unique per
    rack section and give a sharp peak at the true seam.
  - Take a fixed probe strip from the BOTTOM of img_prev (height proportional
    to img height — 1.5%, min 16px).
  - Slide that strip through the TOP of img_next, searching both Y *and* X
    (+/- x_search px) to absorb hand-held lateral drift between shots.
  - Score = 0.4 * (1 - mean |RGB diff|/255) + 0.6 * (1 - mean |edge diff|/norm).
  - Accept the best (x, y) only if its score exceeds the median score by
    peak_margin. This rejects flat scoring curves where no real overlap exists.
  - When accepted, return (cut_rows_in_next, x_shift, score, accepted=True).
    Otherwise return (0, 0, best_score, False) — the caller decides whether
    to butt the images flush, ask the user to retake, or fail the whole job.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List, Tuple

import numpy as np
from PIL import Image


# ─────────────────────────────────────────── Overlap detection ──────────────

def find_overlap(
    img_prev: Image.Image,
    img_next: Image.Image,
    *,
    max_overlap_ratio: float = 0.60,
    probe_h_frac: float = 0.015,
    probe_h_min: int = 16,
    x_search: int = 12,
    peak_margin: float = 0.045,
) -> Tuple[int, int, float, bool]:
    """
    Edge-based template-matching overlap detector with X-jitter compensation.

    Returns (cut_rows, x_shift, score, accepted).
      cut_rows : how many rows to trim from the TOP of img_next before pasting.
                 0 when no confident overlap was found (caller decides what to
                 do — butt flush, error, or ask the user to retake).
      x_shift  : pixel shift in img_next's X relative to img_prev. The caller
                 should paste img_next at offset x=x_shift to align it.
      score    : best combined match score (RGB+edge), in [0, 1].
      accepted : True iff the peak was confidently above noise floor.
    """
    cmp_w = min(img_prev.width, img_next.width, 480)

    def resize_to_cmp(img: Image.Image) -> np.ndarray:
        h = max(1, int(img.height * (cmp_w / img.width)))
        return np.array(img.convert("RGB").resize((cmp_w, h), Image.LANCZOS), dtype=np.float32)

    p_rgb = resize_to_cmp(img_prev)
    n_rgb = resize_to_cmp(img_next)

    def to_edges(rgb: np.ndarray) -> np.ndarray:
        luma = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
        return np.abs(np.diff(luma, axis=0))  # (h-1, w)

    p_edge = to_edges(p_rgb)
    n_edge = to_edges(n_rgb)

    p_h, p_w = p_rgb.shape[:2]
    n_h, n_w = n_rgb.shape[:2]

    probe_h = max(probe_h_min, int(min(p_h, n_h) * probe_h_frac))
    max_cut = int(min(p_h, n_h) * max_overlap_ratio)
    if max_cut < probe_h + 4:
        return 0, 0, 0.0, False

    pad = max(0, x_search)
    if p_w - 2 * pad < 8:
        pad = 0
    probe_rgb = p_rgb[-probe_h:, pad: p_w - pad] if pad else p_rgb[-probe_h:]
    probe_edge = p_edge[-probe_h:, pad: p_w - pad] if pad else p_edge[-probe_h:]
    probe_w = probe_rgb.shape[1]

    probe_edge_mean = float(np.mean(np.abs(probe_edge))) + 1e-6

    scores: List[Tuple[int, int, float]] = []
    dx_range = range(-x_search, x_search + 1) if pad else (0,)

    for cut in range(0, max_cut - probe_h + 1):
        for dx in dx_range:
            x0 = pad + dx
            x1 = x0 + probe_w
            if x0 < 0 or x1 > n_w:
                continue
            wind_rgb = n_rgb[cut: cut + probe_h, x0:x1]
            wind_edge = n_edge[cut: cut + probe_h, x0:x1]

            rgb_score = 1.0 - float(np.mean(np.abs(probe_rgb - wind_rgb))) / 255.0

            wind_edge_mean = float(np.mean(np.abs(wind_edge))) + 1e-6
            denom = probe_edge_mean + wind_edge_mean
            edge_score = 1.0 - float(np.mean(np.abs(probe_edge - wind_edge))) / (denom * 2 + 1e-6)

            scores.append((cut, dx, 0.4 * rgb_score + 0.6 * edge_score))

    if not scores:
        return 0, 0, 0.0, False

    all_vals = [s[2] for s in scores]
    best_cut, best_dx, best_score = max(scores, key=lambda s: s[2])
    median_score = float(np.median(all_vals))

    accepted = (best_score - median_score) >= peak_margin and best_cut > 0
    if not accepted:
        return 0, 0, best_score, False

    cmp_to_next_y = img_next.height / n_h
    cmp_to_next_x = img_next.width / n_w
    cut_rows_native = int(round((best_cut + probe_h) * cmp_to_next_y))
    x_shift_native = int(round(best_dx * cmp_to_next_x))

    return cut_rows_native, x_shift_native, float(best_score), True


# ─────────────────────────────────────────── Auto-arrange ──────────────────

def _pairwise_score(img_a: Image.Image, img_b: Image.Image) -> float:
    """
    Score for "img_b fits directly below img_a". Reuses find_overlap with
    relaxed overlap-ratio (up to 80%, since users often shoot with generous
    overlap when they don't know about the seam algorithm) and tightened
    peak_margin (suppresses false-positive matches that would corrupt the
    chain-finder). x_search is small here — we only care about chain
    ORDERING; the real stitch pass will refine Y/X alignment.

    Returns 0.0 when the match isn't confidently accepted, so non-adjacent
    pairs naturally score zero and the chain-finder ignores them.
    """
    _, _, score, accepted = find_overlap(
        img_a, img_b,
        max_overlap_ratio=0.80,
        x_search=4,
        peak_margin=0.06,
    )
    return float(score) if accepted else 0.0


def auto_arrange_images(images: List[Image.Image]) -> Tuple[List[int], dict]:
    """
    Infer the top-to-bottom order of a set of rack photos by pairwise overlap
    scoring. The user can upload in any order — this returns the indices in
    the inferred chain.

    For N <= 7 we brute-force every permutation (5040 perms for N=7, each
    needing 6 score lookups from a precomputed matrix → microseconds). For
    larger N we fall back to greedy-best-start.

    Returns (ordered_indices, info) where:
      ordered_indices : list of input indices in inferred top→bottom order.
      info            : { "score_matrix": [[...]], "total_score": float,
                          "confidence": float, "method": "brute"|"greedy"|"trivial" }
    """
    n = len(images)
    if n <= 1:
        return list(range(n)), {"method": "trivial", "score_matrix": [], "total_score": 0.0, "confidence": 1.0}

    # Score matrix: M[i][j] = "score if j fits directly below i". Asymmetric:
    # M[i][j] != M[j][i] because we always compare img_a's BOTTOM to img_b's TOP.
    M = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            M[i][j] = _pairwise_score(images[i], images[j])

    if n <= 7:
        from itertools import permutations
        best_chain = None
        best_total = -1.0
        for perm in permutations(range(n)):
            total = sum(M[perm[k]][perm[k + 1]] for k in range(n - 1))
            if total > best_total:
                best_total = total
                best_chain = list(perm)
        method = "brute"
    else:
        # Greedy from each possible start; keep the chain with the highest
        # total. O(N^2) starts × O(N) chain length = O(N^3), fine for N<=12.
        best_chain = None
        best_total = -1.0
        for start in range(n):
            chain = [start]
            used = {start}
            total = 0.0
            while len(chain) < n:
                cur = chain[-1]
                remaining = [j for j in range(n) if j not in used]
                next_idx = max(remaining, key=lambda j: M[cur][j])
                total += M[cur][next_idx]
                chain.append(next_idx)
                used.add(next_idx)
            if total > best_total:
                best_total = total
                best_chain = chain
        method = "greedy"

    # Confidence ≈ mean edge-score along the chosen chain (1.0 = perfect).
    confidence = best_total / (n - 1) if n > 1 else 1.0

    return best_chain, {
        "method": method,
        "score_matrix": M,
        "total_score": float(best_total),
        "confidence": float(confidence),
    }


# ─────────────────────────────────────────── Headless stitcher ──────────────

def stitch_images(
    input_paths: List[str],
    output_path: str,
    *,
    require_all_seams: bool = False,
    auto_order: bool = True,
) -> dict:
    """
    Headless stitcher used by the server's /api/stitch endpoint.

    Args:
      input_paths        : list of image file paths. With auto_order=True
                           (default) the order is INFERRED from the images
                           themselves, so the user can upload in any order.
                           With auto_order=False, paths must already be in
                           top-to-bottom order.
      output_path        : where to write the stitched JPEG/PNG.
      require_all_seams  : if True, fail the job when ANY seam can't be
                           confidently detected. If False, butt the uncertain
                           images flush and surface them in `uncertain`.
      auto_order         : if True, run auto_arrange_images() to infer the
                           correct top→bottom chain before stitching.

    Returns a dict with shape:
      { "ok": bool, "output_path": str, "image_size": [w, h],
        "seams": [...], "uncertain": [int, ...],
        "input_order": [int, ...],   # indices into the original input_paths,
                                     # in the order they were actually stitched
        "auto_order": { "method": str, "confidence": float },
        "error": str (when !ok) }
    """
    if not input_paths:
        return {"ok": False, "seams": [], "uncertain": [], "input_order": [], "error": "no input images provided"}
    if len(input_paths) == 1:
        img = Image.open(input_paths[0]).convert("RGB")
        img.save(output_path, quality=92)
        return {
            "ok": True,
            "output_path": output_path,
            "image_size": [img.width, img.height],
            "seams": [],
            "uncertain": [],
            "input_order": [0],
            "auto_order": {"method": "trivial", "confidence": 1.0},
        }

    images: List[Image.Image] = []
    for p in input_paths:
        if not os.path.exists(p):
            return {"ok": False, "seams": [], "uncertain": [], "input_order": [], "error": f"file not found: {p}"}
        try:
            images.append(Image.open(p).convert("RGB"))
        except Exception as exc:
            return {"ok": False, "seams": [], "uncertain": [], "input_order": [], "error": f"cannot open {p}: {exc}"}

    # Infer the top→bottom order before doing the (slower) full stitch.
    if auto_order:
        order, order_info = auto_arrange_images(images)
        images = [images[i] for i in order]
    else:
        order = list(range(len(images)))
        order_info = {"method": "user", "confidence": 1.0}

    target_w = max(im.width for im in images)

    def resize_w(img: Image.Image) -> Image.Image:
        r = target_w / img.width
        return img.resize((target_w, max(1, int(img.height * r))), Image.LANCZOS)

    seams: List[dict] = []
    uncertain: List[int] = []
    slices: List[Tuple[Image.Image, int]] = [(resize_w(images[0]), 0)]

    for i in range(1, len(images)):
        prev_pil = images[i - 1]
        curr_pil = images[i]
        cut_native, dx_native, score, accepted = find_overlap(prev_pil, curr_pil)

        scale = target_w / curr_pil.width
        cut_scaled = int(cut_native * scale)
        dx_scaled = int(dx_native * scale)

        curr_resized = resize_w(curr_pil)
        if accepted and cut_scaled > 0 and cut_scaled < curr_resized.height:
            curr_resized = curr_resized.crop((0, cut_scaled, curr_resized.width, curr_resized.height))

        seams.append({
            "from": i - 1,
            "to": i,
            "cut_px": cut_scaled,
            "x_shift_px": dx_scaled,
            "score": round(score, 4),
            "accepted": bool(accepted),
        })

        if not accepted:
            uncertain.append(i - 1)
            if require_all_seams:
                return {
                    "ok": False,
                    "seams": seams,
                    "uncertain": uncertain,
                    "input_order": order,
                    "auto_order": {"method": order_info.get("method"), "confidence": order_info.get("confidence")},
                    "error": f"seam {i}->{i+1} could not be detected (best score {score:.2%}); retake those shots with more overlap",
                }

        slices.append((curr_resized, dx_scaled))

    total_h = sum(s.height for s, _ in slices)
    cum_x = 0
    min_x, max_x = 0, target_w
    for idx, (s, dx) in enumerate(slices):
        if idx == 0:
            continue
        cum_x += dx
        min_x = min(min_x, cum_x)
        max_x = max(max_x, cum_x + target_w)
    canvas_w = max_x - min_x
    x_origin = -min_x

    out_img = Image.new("RGB", (canvas_w, total_h), (12, 14, 18))
    y = 0
    cur_x = x_origin
    for idx, (s, dx) in enumerate(slices):
        if idx > 0:
            cur_x += dx
        out_img.paste(s, (cur_x, y))
        y += s.height

    out_img.save(output_path, quality=92)
    return {
        "ok": True,
        "output_path": output_path,
        "image_size": [out_img.width, out_img.height],
        "seams": seams,
        "uncertain": uncertain,
        "input_order": order,
        "auto_order": {"method": order_info.get("method"), "confidence": order_info.get("confidence")},
    }


# ─────────────────────────────────────────── CLI ────────────────────────────

def _cli() -> int:
    ap = argparse.ArgumentParser(description="Stitch multiple rack photos top-to-bottom.")
    ap.add_argument("--inputs", nargs="+", required=True, help="Input image paths in top-to-bottom order.")
    ap.add_argument("--output", required=True, help="Output image path.")
    ap.add_argument("--strict", action="store_true",
                    help="Fail the job if any seam can't be confidently detected.")
    ap.add_argument("--no-auto-order", action="store_true",
                    help="Trust the input order; skip pairwise auto-arrangement.")
    args = ap.parse_args()

    result = stitch_images(
        args.inputs,
        args.output,
        require_all_seams=args.strict,
        auto_order=(not args.no_auto_order),
    )
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


# ─────────────────────────────────────────── GUI (dev tool) ─────────────────
# Tkinter is loaded lazily so the headless API/CLI work on servers without Tk.

def _run_gui() -> None:
    import tkinter as tk
    from tkinter import messagebox, ttk, filedialog
    from PIL import ImageTk

    SAVE_DIR = os.path.dirname(os.path.abspath(__file__))
    OUT_FILE = os.path.join(SAVE_DIR, "rack_stitched.png")

    class RackStitcherApp:
        def __init__(self, root):
            self.root = root
            self.root.title("Rack Image Stitcher — Smart Overlap")
            self.root.geometry("1020x700")
            self.root.configure(bg="#f5f5f3")
            self.root.resizable(True, True)
            self.images = []
            self.thumb_size = (110, 56)
            self._selection = None
            self._result_photo = None
            self._build_ui()

        def _build_ui(self):
            BG = "#f5f5f3"; CARD = "#ffffff"; MUTED = "#6b6b67"
            ACCENT = "#185FA5"; GREEN = "#1D9E75"

            hdr = tk.Frame(self.root, bg=BG)
            hdr.pack(fill="x", padx=24, pady=(16, 2))
            tk.Label(hdr, text="Rack Image Stitcher",
                     font=("Segoe UI", 17, "bold"), bg=BG, fg="#1a1a19").pack(anchor="w")
            tk.Label(hdr,
                     text="Overlapping regions are detected automatically and removed before stitching.",
                     font=("Segoe UI", 10), bg=BG, fg=MUTED).pack(anchor="w", pady=(2, 0))

            bar = tk.Frame(self.root, bg=BG)
            bar.pack(fill="x", padx=24, pady=(10, 6))

            def mkbtn(parent, label, cmd, bg=CARD, fg="#1a1a19"):
                return tk.Button(parent, text=label, command=cmd,
                                 bg=bg, fg=fg, relief="flat", bd=0,
                                 font=("Segoe UI", 10), padx=14, pady=6, cursor="hand2")

            mkbtn(bar, "+  Add Images",       self.add_images, bg=ACCENT, fg="white").pack(side="left", padx=(0,6))
            mkbtn(bar, "Up",                  self.move_up).pack(side="left", padx=(0,4))
            mkbtn(bar, "Down",                self.move_down).pack(side="left", padx=(0,4))
            mkbtn(bar, "X  Remove",           self.remove_selected, fg="#A32D2D").pack(side="left", padx=(0,4))
            mkbtn(bar, "Clear All",           self.clear_all, fg=MUTED).pack(side="left", padx=(0,4))
            mkbtn(bar, "Stitch & Preview",    self.stitch, bg=GREEN, fg="white").pack(side="right")

            self.count_lbl = tk.Label(bar, text="", font=("Segoe UI", 10), bg=BG, fg=MUTED)
            self.count_lbl.pack(side="right", padx=10)

            paned = tk.PanedWindow(self.root, orient="horizontal",
                                   bg=BG, sashwidth=6, sashrelief="flat")
            paned.pack(fill="both", expand=True, padx=24, pady=(0, 8))

            left = tk.Frame(paned, bg=CARD,
                            highlightbackground="#d3d1c7", highlightthickness=1)
            paned.add(left, minsize=260, width=350)
            self.canvas_list = tk.Canvas(left, bg=CARD, highlightthickness=0)
            sb = ttk.Scrollbar(left, orient="vertical", command=self.canvas_list.yview)
            self.canvas_list.configure(yscrollcommand=sb.set)
            sb.pack(side="right", fill="y")
            self.canvas_list.pack(side="left", fill="both", expand=True)
            self.inner = tk.Frame(self.canvas_list, bg=CARD)
            self._win_id = self.canvas_list.create_window((0, 0), window=self.inner, anchor="nw")
            self.inner.bind("<Configure>",
                            lambda e: self.canvas_list.configure(
                                scrollregion=self.canvas_list.bbox("all")))
            self.canvas_list.bind("<Configure>",
                                  lambda e: self.canvas_list.itemconfig(self._win_id, width=e.width))
            self._show_placeholder()

            right = tk.Frame(paned, bg=CARD,
                             highlightbackground="#d3d1c7", highlightthickness=1)
            paned.add(right, minsize=300)
            rh = tk.Frame(right, bg="#f0efeb")
            rh.pack(fill="x")
            tk.Label(rh, text="Stitched Preview",
                     font=("Segoe UI", 10, "bold"), bg="#f0efeb", fg="#1a1a19").pack(side="left", padx=10, pady=7)
            self.result_info = tk.Label(rh, text="", font=("Segoe UI", 9), bg="#f0efeb", fg=MUTED)
            self.result_info.pack(side="left")
            self.result_canvas = tk.Canvas(right, bg="#e8e7e3", highlightthickness=0)
            vsb = ttk.Scrollbar(right, orient="vertical",   command=self.result_canvas.yview)
            hsb = ttk.Scrollbar(right, orient="horizontal", command=self.result_canvas.xview)
            self.result_canvas.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
            hsb.pack(side="bottom", fill="x")
            vsb.pack(side="right",  fill="y")
            self.result_canvas.pack(fill="both", expand=True)
            self.result_canvas.create_text(
                10, 10, anchor="nw",
                text="Stitched image will appear here",
                font=("Segoe UI", 11), fill=MUTED)

            self.status_var = tk.StringVar(value="Ready")
            tk.Label(self.root, textvariable=self.status_var,
                     font=("Segoe UI", 10), bg="#e8e7e3", fg=MUTED,
                     anchor="w", padx=12, pady=5).pack(fill="x", side="bottom")
            self.overlap_var = tk.StringVar(value="")
            self.overlap_bar = tk.Label(self.root, textvariable=self.overlap_var,
                                        font=("Segoe UI", 9), bg="#e1f5ee", fg="#085041",
                                        anchor="w", padx=12, pady=4)
            self.overlap_bar.pack(fill="x", side="bottom")
            self.overlap_bar.pack_forget()

        def add_images(self):
            paths = filedialog.askopenfilenames(
                title="Select rack images",
                filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.bmp *.tiff"), ("All", "*.*")]
            )
            for path in paths:
                try:
                    pil = Image.open(path).convert("RGB")
                    thumb = self._make_thumb(pil)
                    self.images.append({"path": path, "pil": pil, "thumb": thumb})
                except Exception as exc:
                    messagebox.showerror("Error", f"Cannot open {os.path.basename(path)}:\n{exc}")
            self._refresh_list()

        def move_up(self):
            s = self._selection
            if s is None or s == 0: return
            self.images[s-1], self.images[s] = self.images[s], self.images[s-1]
            self._refresh_list(select=s - 1)

        def move_down(self):
            s = self._selection
            if s is None or s >= len(self.images) - 1: return
            self.images[s], self.images[s+1] = self.images[s+1], self.images[s]
            self._refresh_list(select=s + 1)

        def remove_selected(self):
            s = self._selection
            if s is None: return
            self.images.pop(s)
            self._refresh_list(select=min(s, len(self.images)-1) if self.images else None)

        def clear_all(self):
            if self.images and not messagebox.askyesno("Clear all", "Remove all images?"):
                return
            self.images.clear()
            self._selection = None
            self._refresh_list()
            self._clear_result()

        def stitch(self):
            if not self.images:
                messagebox.showwarning("Nothing to stitch", "Add at least one image first.")
                return
            self.status_var.set("Detecting overlaps and stitching...")
            self.overlap_bar.pack_forget()
            self.root.update()
            try:
                result = stitch_images([it["path"] for it in self.images], OUT_FILE)
                if not result.get("ok"):
                    raise RuntimeError(result.get("error") or "stitch failed")
                seams = result.get("seams", [])
                if seams:
                    parts = []
                    for s in seams:
                        if s.get("accepted"):
                            parts.append(f"Seam {s['from']+1}->{s['to']+1}: -{s['cut_px']}px (match {s['score']:.0%})")
                        else:
                            parts.append(f"Seam {s['from']+1}->{s['to']+1}: no overlap (best {s['score']:.0%})")
                    self.overlap_var.set("  |  ".join(parts))
                    self.overlap_bar.pack(fill="x", side="bottom")
                w, h = result["image_size"]
                self._show_result(Image.open(OUT_FILE), w, h)
                total_cut = sum(s.get("cut_px", 0) for s in seams if s.get("accepted"))
                self.status_var.set(
                    f"Saved rack_stitched.png  ({w} x {h}px)  -  Total overlap removed: {total_cut}px"
                )
            except Exception as exc:
                messagebox.showerror("Stitch failed", str(exc))
                self.status_var.set("Error during stitching.")

        def _show_result(self, pil_img, w, h):
            self.result_canvas.delete("all")
            pane_w = max(self.result_canvas.winfo_width(), 300)
            pane_h = max(self.result_canvas.winfo_height(), 400)
            scale = min(pane_w / w, pane_h / h, 1.0)
            disp_w = max(int(w * scale), 1)
            disp_h = max(int(h * scale), 1)
            display = pil_img.resize((disp_w, disp_h), Image.LANCZOS)
            self._result_photo = ImageTk.PhotoImage(display)
            self.result_canvas.create_image(4, 4, anchor="nw", image=self._result_photo)
            self.result_canvas.configure(scrollregion=(0, 0, disp_w + 8, disp_h + 8))
            self.result_info.config(text=f"{w} x {h}px  -  rack_stitched.png")

        def _clear_result(self):
            self.result_canvas.delete("all")
            self.result_canvas.create_text(
                10, 10, anchor="nw",
                text="Stitched image will appear here",
                font=("Segoe UI", 11), fill="#6b6b67")
            self.result_canvas.configure(scrollregion=(0, 0, 0, 0))
            self.result_info.config(text="")
            self.overlap_bar.pack_forget()
            self.status_var.set("Ready")

        def _show_placeholder(self):
            tk.Label(self.inner,
                     text="No images yet.\nClick  + Add Images  to get started.",
                     font=("Segoe UI", 11), bg="#ffffff", fg="#6b6b67",
                     justify="center").pack(pady=60)

        def _refresh_list(self, select=None):
            for w in self.inner.winfo_children():
                w.destroy()
            if not self.images:
                self._show_placeholder()
                self.count_lbl.config(text="")
                self.status_var.set("Ready")
                self._selection = None
                return
            self.row_frames = []
            for i, item in enumerate(self.images):
                self._build_row(i, item)
            n = len(self.images)
            self.count_lbl.config(text=f"{n} image{'s' if n>1 else ''}")
            self.status_var.set(f"{n} image(s) loaded — ready to stitch.")
            target = select if select is not None else self._selection
            if target is not None and 0 <= target < n:
                self._select_row(target)

        def _build_row(self, i, item):
            CARD = "#ffffff"
            row = tk.Frame(self.inner, bg=CARD, cursor="hand2",
                           highlightbackground="#d3d1c7", highlightthickness=1)
            row.pack(fill="x", padx=8, pady=4)
            tk.Label(row, image=item["thumb"], bg=CARD).pack(side="left", padx=10, pady=6)
            info = tk.Frame(row, bg=CARD)
            info.pack(side="left", fill="both", expand=True, pady=6)
            fname = os.path.basename(item["path"])
            pil = item["pil"]
            size_kb = os.path.getsize(item["path"]) // 1024
            tag = "  [full]" if i == 0 else "  [overlap removed]"
            tk.Label(info, text=f"{i+1}.  {fname}", font=("Segoe UI", 10, "bold"),
                     bg=CARD, fg="#1a1a19", anchor="w").pack(anchor="w")
            tk.Label(info, text=f"{pil.width} x {pil.height}px  -  {size_kb} KB{tag}",
                     font=("Segoe UI", 9), bg=CARD, fg="#6b6b67", anchor="w").pack(anchor="w")
            for widget in row.winfo_children():
                widget.bind("<Button-1>", lambda e, idx=i: self._select_row(idx))
                for sub in widget.winfo_children():
                    sub.bind("<Button-1>", lambda e, idx=i: self._select_row(idx))
            row.bind("<Button-1>", lambda e, idx=i: self._select_row(idx))
            self.row_frames.append(row)

        def _select_row(self, index):
            self._selection = index
            for i, row in enumerate(self.row_frames):
                color = "#E6F1FB" if i == index else "#ffffff"
                row.configure(bg=color)
                for child in row.winfo_children():
                    try: child.configure(bg=color)
                    except Exception: pass
                    for sub in child.winfo_children():
                        try: sub.configure(bg=color)
                        except Exception: pass

        def _make_thumb(self, pil_img):
            t = pil_img.copy()
            t.thumbnail(self.thumb_size, Image.LANCZOS)
            return ImageTk.PhotoImage(t)

    root = tk.Tk()
    RackStitcherApp(root)
    root.mainloop()


# ─────────────────────────────────────────── Entry ──────────────────────────

if __name__ == "__main__":
    if any(a.startswith("--") for a in sys.argv[1:]):
        raise SystemExit(_cli())
    _run_gui()
