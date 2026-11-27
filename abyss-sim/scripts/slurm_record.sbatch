#!/bin/bash
# Example SLURM job. Adjust partition / account to your cluster.
# Needs an RTX-class GPU (L40S, A40, RTX 6000, ...). A100/H100 have no RT cores -> no camera rendering.
#SBATCH --job-name=abyss-sim
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=02:00:00
#SBATCH --output=abyss_%j.log
cd "${SLURM_SUBMIT_DIR:-$HOME/abyss-sim}"
./scripts/run_cluster.sh
