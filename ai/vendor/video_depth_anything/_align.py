# Vendored from Video-Depth-Anything/utils/util.py (Bytedance Ltd., Apache-2.0).
# Only the two helpers `video_depth.py` needs for cross-window scale/shift
# alignment — pulled in-package so the vendored tree has no repo-root `utils`
# dependency. Unmodified logic.
import numpy as np


def compute_scale_and_shift(prediction, target, mask, scale_only=False):
    if scale_only:
        return compute_scale(prediction, target, mask), 0
    return compute_scale_and_shift_full(prediction, target, mask)


def compute_scale(prediction, target, mask):
    prediction = prediction.astype(np.float32)
    target = target.astype(np.float32)
    mask = mask.astype(np.float32)

    a_00 = np.sum(mask * prediction * prediction)
    b_0 = np.sum(mask * prediction * target)
    return b_0 / (a_00 + 1e-6)


def compute_scale_and_shift_full(prediction, target, mask):
    prediction = prediction.astype(np.float32)
    target = target.astype(np.float32)
    mask = mask.astype(np.float32)

    a_00 = np.sum(mask * prediction * prediction)
    a_01 = np.sum(mask * prediction)
    a_11 = np.sum(mask)

    b_0 = np.sum(mask * prediction * target)
    b_1 = np.sum(mask * target)

    x_0, x_1 = 1, 0
    det = a_00 * a_11 - a_01 * a_01
    if det != 0:
        x_0 = (a_11 * b_0 - a_01 * b_1) / det
        x_1 = (-a_01 * b_0 + a_00 * b_1) / det
    return x_0, x_1


def get_interpolate_frames(frame_list_pre, frame_list_post):
    assert len(frame_list_pre) == len(frame_list_post)
    n = len(frame_list_pre)
    step = 1.0 / (n - 1)
    post_w_list = [0.0] + [i * step for i in range(1, n - 1)] + [1.0]
    return [
        frame_list_pre[i] * (1 - post_w_list[i]) + frame_list_post[i] * post_w_list[i]
        for i in range(n)
    ]
