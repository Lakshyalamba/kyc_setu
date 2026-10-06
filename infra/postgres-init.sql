-- Runs once on first volume init. Separate DB so `pnpm test` never touches dev data.
CREATE DATABASE kyc_setu_test;
