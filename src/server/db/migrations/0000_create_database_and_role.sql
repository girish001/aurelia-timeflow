-- ============================================================================
-- Aurelia TimeFlow Pre-Migration Bootstrap: 0000_create_database_and_role.sql
-- Target: Private AWS RDS PostgreSQL in ap-south-1 (aurelia-timeflow-db-mumbai)
--
-- IMPORTANT EXECUTION NOTES:
-- 1. DO NOT execute this script from Google AI Studio or outside the AWS VPC.
-- 2. Connect from inside the private ap-south-1 VPC to the default RDS
--    database (`dbname=postgres`) as the RDS master user.
-- 3. `CREATE DATABASE` cannot run inside a `BEGIN ... COMMIT` transaction block.
--    Run this file with `psql` before executing `0001_initial_multi_tenant.sql`.
-- ============================================================================

-- Step 1: Create the dedicated `aurelia_timeflow` database if you choose not to
-- use the default `postgres` database shown in the AWS RDS console.
-- (In psql, `\gexec` executes the generated CREATE DATABASE statement only if absent.)
SELECT 'CREATE DATABASE aurelia_timeflow ENCODING ''UTF8'''
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = 'aurelia_timeflow'
)\gexec

-- Step 2: Create the least-privilege application role (NOSUPERUSER, NOBYPASSRLS).
-- Replace <CHANGE_ME_STRONG_SECRET_FROM_SECRETS_MANAGER> at execution time inside the VPC.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aurelia_app') THEN
    CREATE ROLE aurelia_app WITH
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOBYPASSRLS
      NOINHERIT;
  END IF;
END
$$;

-- Step 3: After connecting to the target database (`postgres` or `aurelia_timeflow`)
-- and executing `0001_initial_multi_tenant.sql`, grant table-level CRUD privileges
-- to `aurelia_app` without granting SUPERUSER or BYPASSRLS:
--
-- GRANT USAGE ON SCHEMA public TO aurelia_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aurelia_app;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aurelia_app;
