"""
attention_tracker.py: Real-time Attention and Drowsiness Tracking Engine.

Features:
- Head Pose Estimation (Yaw, Pitch, Roll) via cv2.solvePnP & RQDecomp3x3
- Eye Aspect Ratio (EAR) computation across bilateral facial landmarks
- Stateful temporal distraction tracking:
  - Absolute Head Yaw > 30° (looking away)
  - EAR < 0.21 continuously for > 5.0 seconds (drowsiness / eyes closed)
- Trigger generation for pedagogical re-engagement interventions
- Global telemetry store accessible across ports
"""

import time
import logging
from typing import List, Dict, Any, Optional, Tuple, Union
import numpy as np
import cv2

from .config import settings

logger = logging.getLogger("avatar-attention")
logger.setLevel(logging.INFO)


class AttentionTracker:
    # 3D Canonical Face Model Points for PnP estimation
    MODEL_POINTS_3D = np.array(
        [
            [0.0, 0.0, 0.0],          # Nose tip (landmark 1)
            [0.0, -330.0, -65.0],     # Chin (landmark 152)
            [-225.0, 170.0, -135.0],  # Left eye outer corner (landmark 33)
            [225.0, 170.0, -135.0],   # Right eye outer corner (landmark 263)
            [-150.0, -150.0, -125.0], # Left mouth corner (landmark 61)
            [150.0, -150.0, -125.0],  # Right mouth corner (landmark 291)
        ],
        dtype=np.float64,
    )

    POSE_LANDMARKS = [1, 152, 33, 263, 61, 291]

    LEFT_EYE_LANDMARKS = {
        "p1": 33,
        "p2": 160,
        "p3": 158,
        "p4": 133,
        "p5": 153,
        "p6": 144,
    }

    RIGHT_EYE_LANDMARKS = {
        "p1": 362,
        "p2": 385,
        "p3": 387,
        "p4": 263,
        "p5": 373,
        "p6": 380,
    }

    def __init__(
        self,
        yaw_threshold: float = settings.yaw_threshold_deg,
        ear_threshold: float = settings.ear_threshold,
        eyes_closed_sec: float = settings.eyes_closed_duration_sec,
        pitch_threshold: float = 28.0,
        no_face_sec: float = 2.5,
    ):
        self.yaw_threshold = yaw_threshold
        self.ear_threshold = ear_threshold
        self.eyes_closed_sec = eyes_closed_sec
        self.pitch_threshold = pitch_threshold
        self.no_face_sec = no_face_sec
        self.session_states: Dict[str, Dict[str, Any]] = {}
        self.latest_telemetry: Dict[str, Any] = {
            "status": "Attentive",
            "is_distracted": False,
            "trigger_prompt_override": False,
            "reason": "",
            "metrics": {
                "yaw_deg": 0.0,
                "pitch_deg": 0.0,
                "roll_deg": 0.0,
                "ear": 0.32,
                "eyes_closed_duration_sec": 0.0,
            },
            "timestamp": time.time(),
        }

    def _get_session_state(self, session_id: str) -> Dict[str, Any]:
        if session_id not in self.session_states:
            self.session_states[session_id] = {
                "eyes_closed_start": None,
                "no_face_start": None,
                "distracted_start": None,
                "last_alert_time": 0.0,
                "is_distracted": False,
            }
        return self.session_states[session_id]

    @staticmethod
    def calculate_single_ear(
        p1: Tuple[float, float],
        p2: Tuple[float, float],
        p3: Tuple[float, float],
        p4: Tuple[float, float],
        p5: Tuple[float, float],
        p6: Tuple[float, float],
    ) -> float:
        """Computes the Eye Aspect Ratio (EAR) for a single eye."""
        p1, p2, p3, p4, p5, p6 = map(np.array, (p1, p2, p3, p4, p5, p6))
        v1 = np.linalg.norm(p2 - p6)
        v2 = np.linalg.norm(p3 - p5)
        h = np.linalg.norm(p1 - p4)
        if h < 1e-6:
            return 0.0
        return float((v1 + v2) / (2.0 * h))

    def calculate_bilateral_ear(
        self,
        landmarks: Any,
        image_width: int = 640,
        image_height: int = 480,
    ) -> Tuple[float, float, float]:
        def get_coords(idx: int) -> Tuple[float, float]:
            if hasattr(landmarks, "landmark"):
                lm = landmarks.landmark[idx]
                return (lm.x * image_width, lm.y * image_height)
            elif isinstance(landmarks, list) and isinstance(landmarks[idx], dict):
                return (landmarks[idx]["x"] * image_width, landmarks[idx]["y"] * image_height)
            elif isinstance(landmarks, (list, np.ndarray)):
                lm = landmarks[idx]
                return (lm[0] * image_width, lm[1] * image_height)
            raise ValueError(f"Unsupported landmarks format at index {idx}")

        le = self.LEFT_EYE_LANDMARKS
        left_ear = self.calculate_single_ear(
            get_coords(le["p1"]), get_coords(le["p2"]), get_coords(le["p3"]),
            get_coords(le["p4"]), get_coords(le["p5"]), get_coords(le["p6"]),
        )
        re = self.RIGHT_EYE_LANDMARKS
        right_ear = self.calculate_single_ear(
            get_coords(re["p1"]), get_coords(re["p2"]), get_coords(re["p3"]),
            get_coords(re["p4"]), get_coords(re["p5"]), get_coords(re["p6"]),
        )
        avg_ear = (left_ear + right_ear) / 2.0
        return float(avg_ear), float(left_ear), float(right_ear)

    def calculate_head_pose(
        self,
        landmarks: Any,
        image_width: int = 640,
        image_height: int = 480,
    ) -> Tuple[float, float, float]:
        image_points = []
        for idx in self.POSE_LANDMARKS:
            if hasattr(landmarks, "landmark"):
                lm = landmarks.landmark[idx]
                image_points.append([lm.x * image_width, lm.y * image_height])
            elif isinstance(landmarks, list) and isinstance(landmarks[idx], dict):
                image_points.append([landmarks[idx]["x"] * image_width, landmarks[idx]["y"] * image_height])
            elif isinstance(landmarks, (list, np.ndarray)):
                lm = landmarks[idx]
                image_points.append([lm[0] * image_width, lm[1] * image_height])

        image_points_2d = np.array(image_points, dtype=np.float64)

        focal_length = image_width
        center = (image_width / 2.0, image_height / 2.0)
        camera_matrix = np.array(
            [[focal_length, 0, center[0]], [0, focal_length, center[1]], [0, 0, 1]],
            dtype=np.float64,
        )
        dist_coeffs = np.zeros((4, 1), dtype=np.float64)

        success, rvec, tvec = cv2.solvePnP(
            self.MODEL_POINTS_3D,
            image_points_2d,
            camera_matrix,
            dist_coeffs,
            flags=cv2.SOLVEPNP_ITERATIVE,
        )

        if not success:
            return 0.0, 0.0, 0.0

        rmat, _ = cv2.Rodrigues(rvec)
        angles, _, _, _, _, _ = cv2.RQDecomp3x3(rmat)
        pitch, yaw, roll = float(angles[0]), float(angles[1]), float(angles[2])
        # Normalize upside-down camera coordinate frame pitch/roll to [-90, +90]
        if pitch > 90.0:
            pitch -= 180.0
        elif pitch < -90.0:
            pitch += 180.0
        if roll > 90.0:
            roll -= 180.0
        elif roll < -90.0:
            roll += 180.0
        return pitch, yaw, roll

    def _compute_alert_trigger(self, state: Dict[str, Any], is_distracted: bool, now: float) -> bool:
        was_distracted = state["is_distracted"]
        state["is_distracted"] = is_distracted
        if not is_distracted:
            return False
        # Immediate trigger on transition Attentive -> Distracted (min 6s cooldown),
        # or periodic reminder every 15s while continuously distracted
        cooldown = 6.0 if not was_distracted else 15.0
        if now - state["last_alert_time"] >= cooldown:
            state["last_alert_time"] = now
            return True
        return False

    def evaluate_attention(
        self,
        yaw: float,
        pitch: float,
        roll: float,
        ear: float,
        session_id: str = "default",
    ) -> Dict[str, Any]:
        now = time.time()
        state = self._get_session_state(session_id)
        state["no_face_start"] = None

        is_distracted = False
        reasons = []

        # 1. Head Pose (Yaw & Pitch) check
        if abs(yaw) > self.yaw_threshold:
            is_distracted = True
            reasons.append(f"Looking away (Head yaw: {yaw:.1f}° > {self.yaw_threshold:.0f}°)")
        elif abs(pitch) > self.pitch_threshold:
            is_distracted = True
            reasons.append(f"Looking up/down (Head pitch: {pitch:.1f}° > {self.pitch_threshold:.0f}°)")

        # 2. Eye Aspect Ratio (EAR) check
        eyes_closed_duration = 0.0
        if ear < self.ear_threshold:
            if state["eyes_closed_start"] is None:
                state["eyes_closed_start"] = now
            else:
                eyes_closed_duration = now - state["eyes_closed_start"]
                if eyes_closed_duration >= self.eyes_closed_sec:
                    is_distracted = True
                    reasons.append(
                        f"Drowsiness detected (Eyes closed for {eyes_closed_duration:.1f}s)"
                    )
        else:
            state["eyes_closed_start"] = None

        trigger_prompt_override = self._compute_alert_trigger(state, is_distracted, now)

        result = {
            "status": "Distracted" if is_distracted else "Attentive",
            "is_distracted": is_distracted,
            "trigger_prompt_override": trigger_prompt_override,
            "reason": " & ".join(reasons) if reasons else "Attentive and engaged",
            "metrics": {
                "yaw_deg": round(yaw, 1),
                "pitch_deg": round(pitch, 1),
                "roll_deg": round(roll, 1),
                "ear": round(ear, 3),
                "eyes_closed_duration_sec": round(eyes_closed_duration, 1),
            },
            "timestamp": now,
        }

        self.latest_telemetry = result
        return result

    def process_no_face(self, session_id: str = "default") -> Dict[str, Any]:
        """Handles frames where no face is detected in the webcam view."""
        now = time.time()
        state = self._get_session_state(session_id)
        if state["no_face_start"] is None:
            state["no_face_start"] = now
        away_sec = now - state["no_face_start"]
        is_distracted = away_sec >= self.no_face_sec
        trigger_prompt_override = self._compute_alert_trigger(state, is_distracted, now)

        result = {
            "status": "Distracted" if is_distracted else "Attentive",
            "is_distracted": is_distracted,
            "trigger_prompt_override": trigger_prompt_override,
            "reason": f"Stepped away / face not visible ({away_sec:.1f}s)" if is_distracted else "Searching for face...",
            "metrics": {
                "yaw_deg": 0.0,
                "pitch_deg": 0.0,
                "roll_deg": 0.0,
                "ear": 0.0,
                "eyes_closed_duration_sec": 0.0,
            },
            "timestamp": now,
        }
        self.latest_telemetry = result
        return result

    def process_landmarks(
        self,
        landmarks: Any,
        session_id: str = "default",
        image_width: int = 640,
        image_height: int = 480,
    ) -> Dict[str, Any]:
        try:
            ear, _, _ = self.calculate_bilateral_ear(landmarks, image_width, image_height)
            pitch, yaw, roll = self.calculate_head_pose(landmarks, image_width, image_height)
            return self.evaluate_attention(yaw, pitch, roll, ear, session_id=session_id)
        except Exception as e:
            logger.warning(f"Error processing landmarks: {e}")
            return {
                "status": "Error",
                "is_distracted": False,
                "trigger_prompt_override": False,
                "reason": str(e),
                "metrics": {
                    "yaw_deg": 0.0,
                    "pitch_deg": 0.0,
                    "roll_deg": 0.0,
                    "ear": 0.32,
                    "eyes_closed_duration_sec": 0.0,
                },
                "timestamp": time.time(),
            }

    def simulate(self, sim_type: str = "normal", session_id: str = "default") -> Dict[str, Any]:
        """Provides simulated data for testing without a webcam."""
        state = self._get_session_state(session_id)
        if sim_type == "yaw":
            state["is_distracted"] = False
            state["last_alert_time"] = 0.0
            return self.evaluate_attention(
                yaw=42.5, pitch=5.0, roll=2.0, ear=0.32, session_id=session_id
            )
        elif sim_type == "drowsy":
            state["is_distracted"] = False
            state["last_alert_time"] = 0.0
            state["eyes_closed_start"] = time.time() - (self.eyes_closed_sec + 2.0)
            return self.evaluate_attention(
                yaw=4.0, pitch=-10.0, roll=0.0, ear=0.14, session_id=session_id
            )
        else:
            state["eyes_closed_start"] = None
            state["no_face_start"] = None
            return self.evaluate_attention(
                yaw=1.2, pitch=2.0, roll=0.5, ear=0.34, session_id=session_id
            )


attention_tracker = AttentionTracker()
