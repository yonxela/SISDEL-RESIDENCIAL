-- ═══════════════════════════════════════════════════════════════
-- SISDEL Cloud Database Migration (Supabase PostgreSQL Schema)
-- ═══════════════════════════════════════════════════════════════

-- 1. Table: condominios
CREATE TABLE public.condominios (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  name character varying NOT NULL,
  address text NULL,
  phone character varying NULL,
  active boolean NOT NULL DEFAULT true,
  createdAt timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  serviceExpiry timestamp with time zone NULL,
  CONSTRAINT condominios_pkey PRIMARY KEY (id)
);

-- 2. Table: users
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  condominioId uuid NOT NULL,
  name character varying NOT NULL,
  role character varying NOT NULL,
  accessCode character varying NOT NULL,
  casa character varying NULL,
  phone character varying NULL,
  email character varying NULL,
  paymentStatus character varying NULL,
  active boolean NOT NULL DEFAULT true,
  createdAt timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_condominioId_fkey FOREIGN KEY (condominioId) REFERENCES condominios (id) ON DELETE CASCADE
);

-- 3. Table: visits
CREATE TABLE public.visits (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  condominioId uuid NOT NULL,
  userId uuid NOT NULL,
  visitorName character varying NOT NULL,
  visitorInfo text NULL,
  vehiclePlate character varying NULL,
  visitDate date NOT NULL,
  visitTime time without time zone NULL,
  casa character varying NULL,
  qrCode character varying NOT NULL,
  status character varying NOT NULL DEFAULT 'pending'::character varying,
  createdAt timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  enteredAt timestamp with time zone NULL,
  CONSTRAINT visits_pkey PRIMARY KEY (id),
  CONSTRAINT visits_condominioId_fkey FOREIGN KEY (condominioId) REFERENCES condominios (id) ON DELETE CASCADE,
  CONSTRAINT visits_userId_fkey FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
);

-- 4. Table: vehicles
CREATE TABLE public.vehicles (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  condominioId uuid NOT NULL,
  userId uuid NOT NULL,
  plate character varying NOT NULL,
  brand character varying NULL,
  model character varying NULL,
  color character varying NULL,
  marbeteCode character varying NOT NULL,
  createdAt timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT vehicles_pkey PRIMARY KEY (id),
  CONSTRAINT vehicles_condominioId_fkey FOREIGN KEY (condominioId) REFERENCES condominios (id) ON DELETE CASCADE,
  CONSTRAINT vehicles_userId_fkey FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
);

-- 5. Table: messages
CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  condominioId text NOT NULL, -- UUID or 'all'
  fromName character varying NOT NULL,
  toRole character varying NOT NULL,
  subject text NULL,
  body text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  createdAt timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT messages_pkey PRIMARY KEY (id)
);

-- IMPORTANT: 
-- You might want to run the following command to allow anonymous reads and writes 
-- if you are not dealing with RLS right away.
-- WARNING: This exposes APIs, but is required if RLS is not properly configured.
--
-- ALTER TABLE public.condominios ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Enable full access for all users" ON public.condominios FOR ALL USING (true) WITH CHECK (true);
--
-- (Repeat for users, visits, vehicles and messages inside the Supabase Auth Policies dashboard).
