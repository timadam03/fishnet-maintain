"""
train_fishfarm_nav.py -- retrain the level-3 (PPO + HOCBF) navigator for a fish-farm net pen and
export it for the Isaac Sim demo.

Put this file AND safe_nav.py in the SJTU_SafeRL_AUV repo root (next to train_nav.py) and run it
in the repo's Python 3.10 venv (it reuses finrl.ppo, so no new dependencies):

    python train_fishfarm_nav.py --total-steps 300000 --cbf            # level 3 (recommended)
    python train_fishfarm_nav.py --total-steps 300000 --w-safety 2     # level 1, for comparison
    python train_fishfarm_nav.py --total-steps 300000 --cbf --cbf-reward 0.3   # HOCBF in reward + hard filter
    python train_fishfarm_nav.py --selftest                            # env + filter check, no training

Outputs  fishfarm_nav.pt  (torch state_dict)  and  fishfarm_nav.npz  (numpy weights + config,
loaded by fishfarm_demo.py --nav-policy fishfarm_nav.npz).

Environment = finrl NavEnv2D re-built for a net pen:
  - arena: inside a circular net (radius 8 m), wall is an inside-circle HOCBF barrier
  - obstacles: 0-6 random vertical ropes / hoses / pillars (radius 0.1-0.45 m), half of them
    placed near the start->goal line so the policy must learn to route around them
  - water current randomized per episode (0-0.2 m/s), known to the filter, NOT observed by the policy
  - same obs layout ([goal rel, dist, vel, 8 rays]), same reward terms, same Dykstra QP filter
"""
import argparse
import json
import math

import numpy as np

import safe_nav as sn


class FishFarmNavEnv:
    def __init__(self, cfg, use_cbf=True, w_safety=0.0, max_obstacles=6, seed=0, w_cbf_reward=0.0,
                 max_current=0.2, max_steps=400):
        self.cfg = cfg
        self.rng = np.random.default_rng(seed)
        self.use_cbf, self.w_safety = use_cbf, w_safety
        self.w_cbf_reward = w_cbf_reward     # HOCBF-in-reward weight (0 = off)
        self.max_obstacles, self.max_current, self.max_steps = max_obstacles, max_current, max_steps
        self.obs_dim, self.act_dim = 5 + cfg["n_rays"], 2
        self.filter = sn.SafetyFilter(cfg["a_max"], cfg["drag"], cfg["alpha1"], cfg["alpha2"],
                                      cfg["net_radius"], cfg["inflation"], cfg["detect_radius"])
        self.goal_radius, self.safety_buffer = 0.4, 0.5
        self.w_progress, self.w_step, self.reach_bonus, self.collision_penalty = 1.0, 0.01, 10.0, 10.0

    # ---- helpers
    def _disk_point(self, r_max):
        r = r_max * math.sqrt(self.rng.uniform())
        a = self.rng.uniform(0, 2 * math.pi)
        return np.array([r * math.cos(a), r * math.sin(a)])

    def _clr(self, p):
        """Physical clearance (vehicle hull to obstacle surface); < 0 = contact = collision."""
        return sn.clearance(p, self.circles, self.cfg["net_radius"], self.cfg["vehicle_radius"])

    def _obs(self):
        return sn.build_obs(self.p, self.v, self.goal, self.circles, self.cfg["net_radius"],
                            self.cfg["n_rays"], self.cfg["ray_max"])

    # ---- API (same as finrl NavEnv2D / SingleAgentUnityEnv)
    def reset(self):
        c = self.cfg
        r_free = c["net_radius"] - c["inflation"] - 0.4
        while True:
            s, g = self._disk_point(r_free), self._disk_point(r_free)
            if np.linalg.norm(g - s) >= 3.0:
                break
        circles = []
        for _ in range(int(self.rng.integers(0, self.max_obstacles + 1))):
            for _try in range(30):
                r = self.rng.uniform(0.1, 0.45)
                if self.rng.uniform() < 0.5:     # on/near the direct route -> must route around
                    t = self.rng.uniform(0.25, 0.75)
                    n = np.array([-(g - s)[1], (g - s)[0]]) / np.linalg.norm(g - s)
                    cxy = s + t * (g - s) + n * self.rng.normal(0, 0.5)
                else:
                    cxy = self._disk_point(c["net_radius"] - 1.0)
                ok = all(np.linalg.norm(q - cxy) - r - c["inflation"] > 0.5 for q in (s, g))
                ok &= np.linalg.norm(cxy) + r < c["net_radius"] - 0.8
                if ok:
                    circles.append((cxy[0], cxy[1], r))
                    break
        self.circles = np.array(circles, float).reshape(-1, 3)
        ang = self.rng.uniform(0, 2 * math.pi)
        mag = self.rng.uniform(0, self.max_current)
        self.current = mag * np.array([math.cos(ang), math.sin(ang)])
        self.filter.current = self.current
        self.p, self.v, self.goal = s.copy(), np.zeros(2), g
        self.steps = 0
        self.prev_dist = np.linalg.norm(g - s)
        return self._obs()

    def step(self, action):
        c = self.cfg
        u = np.clip(np.asarray(action, float).reshape(-1)[:2], -1, 1)
        info = {}
        u_policy = u.copy()
        cbf_edit = 0.0
        if self.use_cbf or self.w_cbf_reward > 0:
            # what the HOCBF would let through for the policy's own action
            u_safe, cbf_info = self.filter.filter(self.p, self.v, u, self.circles)
            cbf_edit = float(np.sum((u_safe - u_policy) ** 2))    # 0 = policy already respects every barrier
            info["cbf"] = cbf_info
            if self.use_cbf:                                      # hard filter: execute the safe action
                u = u_safe
        a = c["a_max"] * u
        self.v = self.v + (a - c["drag"] * self.v) * c["dt"]
        self.p = self.p + (self.v + self.current) * c["dt"]
        self.steps += 1
        dist = float(np.linalg.norm(self.goal - self.p))
        clr = self._clr(self.p)
        margin = self.cfg["inflation"] - self.cfg["vehicle_radius"]    # safety buffer the CBF keeps
        reward = self.w_progress * (self.prev_dist - dist) - self.w_step
        self.prev_dist = dist
        done = False
        info.update(clearance=clr, success=False, collision=False, margin_violation=clr < margin - 0.02)
        if clr <= 0.0:
            reward -= self.collision_penalty
            done = info["collision"] = True
        elif dist < self.goal_radius:
            reward += self.reach_bonus
            done = info["success"] = True
        elif self.steps >= self.max_steps:
            done = True
        reward -= self.w_safety * max(0.0, self.safety_buffer + margin - clr)
        # HOCBF in the reward: penalise the policy for proposing an action the barrier has to correct.
        # The policy learns to respect h >= 0 by itself; with --cbf the filter stays on as the hard guarantee.
        reward -= self.w_cbf_reward * cbf_edit
        info["cbf_edit"] = cbf_edit
        return self._obs(), float(reward), bool(done), info

    def close(self):
        pass


def evaluate(env, act_fn, episodes=100):
    succ = coll = steps = interv = infeas = viol = 0
    min_clr = []
    for _ in range(episodes):
        obs, done, ep_min = env.reset(), False, np.inf
        while not done:
            obs, _, done, info = env.step(act_fn(obs))
            ep_min = min(ep_min, info["clearance"])
            viol += int(info["margin_violation"])
            steps += 1
            if "cbf" in info:
                interv += int(info["cbf"]["intervened"])
                infeas += int(info["cbf"]["infeasible"])
        succ += int(info["success"])
        coll += int(info["collision"])
        min_clr.append(ep_min)
    return dict(success=succ / episodes, collision=coll / episodes, min_clear=float(np.mean(min_clr)),
                margin_violation_rate=viol / max(steps, 1),
                intervention_rate=interv / max(steps, 1), infeasible_rate=infeas / max(steps, 1))


def export_npz(actor_mu, cfg, path):
    import torch.nn as nn
    lin = [m for m in actor_mu if isinstance(m, nn.Linear)]
    arrays = {"n_layers": np.array(len(lin)), "cfg": np.array(json.dumps(cfg))}
    for i, m in enumerate(lin):
        arrays[f"W{i}"] = m.weight.detach().cpu().numpy().astype(np.float32)
        arrays[f"b{i}"] = m.bias.detach().cpu().numpy().astype(np.float32)
    np.savez(path, **arrays)


def goal_seeking(env):
    """Hand-written nominal controller (no learning) -- used by --selftest."""
    def act(_obs):
        e = env.goal - env.p
        return np.clip((1.0 * e - 1.6 * env.v) / env.cfg["a_max"], -1, 1)
    return act


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--total-steps", type=int, default=300_000)
    ap.add_argument("--cbf", action="store_true", help="level 3: HOCBF filter during training")
    ap.add_argument("--cbf-reward", type=float, default=0.0,
                    help="HOCBF in the reward: weight on how much the filter must edit the policy's action "
                         "(e.g. 0.3). Combine with --cbf for learned avoidance + hard guarantee")
    ap.add_argument("--w-safety", type=float, default=0.0, help="level 1 soft clearance penalty")
    ap.add_argument("--max-obstacles", type=int, default=6)
    ap.add_argument("--out", default="fishfarm_nav")
    ap.add_argument("--selftest", action="store_true")
    for k in ("a_max", "drag", "net_radius", "inflation", "alpha1", "alpha2", "detect_radius"):
        ap.add_argument(f"--{k.replace('_', '-')}", type=float, default=sn.DEFAULTS[k])
    args = ap.parse_args()
    cfg = dict(sn.DEFAULTS)
    cfg.update({k: getattr(args, k) for k in ("a_max", "drag", "net_radius", "inflation",
                                               "alpha1", "alpha2", "detect_radius")})

    if args.selftest:
        for use_cbf in (False, True):
            env = FishFarmNavEnv(cfg, use_cbf=use_cbf, max_obstacles=args.max_obstacles, seed=1)
            r = evaluate(env, goal_seeking(env), 200)
            print(f"[selftest] goal-seeking, cbf={use_cbf}: " + ", ".join(f"{k}={v:.3f}" for k, v in r.items()))
        return

    import torch
    from finrl.ppo import PPO, PPOConfig

    env = FishFarmNavEnv(cfg, use_cbf=args.cbf, w_safety=args.w_safety, max_obstacles=args.max_obstacles,
                         w_cbf_reward=args.cbf_reward)
    tag = "level3-HOCBF" if args.cbf else ("level1-soft" if args.w_safety > 0 else "level0-none")
    if args.cbf_reward > 0:
        tag += f"+cbf-reward{args.cbf_reward:g}"
    print(f"[fishfarm-nav] {tag}  cfg={cfg}")
    ppo = PPO(env, PPOConfig(total_steps=args.total_steps, rollout_len=2048, ent_coef=0.01, hidden=(256, 256)))
    ppo.train(log_every=5)
    ppo.save(args.out + ".pt")

    mu = ppo.ac.actor.mu
    def act(obs):
        with torch.no_grad():
            return torch.clamp(mu(torch.as_tensor(obs, dtype=torch.float32)), -1, 1).numpy()
    r = evaluate(env, act, 100)
    print(f"\n[eval 100 eps | {tag} | deterministic] " + ", ".join(f"{k}={v:.3f}" for k, v in r.items()))
    if args.cbf:   # how good is the learned policy on its own, filter OFF?
        env.use_cbf = False
        r_raw = evaluate(env, act, 100)
        env.use_cbf = True
        print("[eval 100 eps | same policy, filter OFF] " + ", ".join(f"{k}={v:.3f}" for k, v in r_raw.items()))
        r["policy_alone"] = r_raw
    cfg_out = dict(cfg, trained_with_cbf=bool(args.cbf), eval=r)
    export_npz(mu, cfg_out, args.out + ".npz")
    print(f"[done] {args.out}.pt + {args.out}.npz  ->  fishfarm_demo.py --nav-policy {args.out}.npz")


if __name__ == "__main__":
    main()
