-- ═══════════════════════════════════════════════════════════════
-- SISDEL Cloud Database Migration (Supabase PostgreSQL Schema)
-- ═══════════════════════════════════════════════════════════════

-- 1. Table: sisdel_condominios
CREATE TABLE public.sisdel_condominios (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  name character varying NOT NULL,
  address text NULL,
  phone character varying NULL,
  active boolean NOT NULL DEFAULT true,
  "createdAt" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "serviceExpiry" timestamp with time zone NULL,
  CONSTRAINT sisdel_condominios_pkey PRIMARY KEY (id)
);

-- 2. Table: sisdel_users
CREATE TABLE public.sisdel_users (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "condominioId" uuid NOT NULL,
  name character varying NOT NULL,
  role character varying NOT NULL,
  "accessCode" character varying NOT NULL,
  casa character varying NULL,
  phone character varying NULL,
  email character varying NULL,
  "paymentStatus" character varying NULL,
  active boolean NOT NULL DEFAULT true,
  "createdAt" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT sisdel_users_pkey PRIMARY KEY (id),
  CONSTRAINT sisdel_users_condominioId_fkey FOREIGN KEY ("condominioId") REFERENCES sisdel_condominios (id) ON DELETE CASCADE
);

-- 3. Table: sisdel_visits
CREATE TABLE public.sisdel_visits (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "condominioId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "visitorName" character varying NOT NULL,
  "visitorInfo" text NULL,
  "vehiclePlate" character varying NULL,
  "visitDate" date NOT NULL,
  "visitTime" time without time zone NULL,
  casa character varying NULL,
  "qrCode" character varying NOT NULL,
  status character varying NOT NULL DEFAULT 'pending'::character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "enteredAt" timestamp with time zone NULL,
  CONSTRAINT sisdel_visits_pkey PRIMARY KEY (id),
  CONSTRAINT sisdel_visits_condominioId_fkey FOREIGN KEY ("condominioId") REFERENCES sisdel_condominios (id) ON DELETE CASCADE,
  CONSTRAINT sisdel_visits_userId_fkey FOREIGN KEY ("userId") REFERENCES sisdel_users (id) ON DELETE CASCADE
);

-- 4. Table: sisdel_vehicles
CREATE TABLE public.sisdel_vehicles (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "condominioId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  plate character varying NOT NULL,
  brand character varying NULL,
  model character varying NULL,
  color character varying NULL,
  "marbeteCode" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT sisdel_vehicles_pkey PRIMARY KEY (id),
  CONSTRAINT sisdel_vehicles_condominioId_fkey FOREIGN KEY ("condominioId") REFERENCES sisdel_condominios (id) ON DELETE CASCADE,
  CONSTRAINT sisdel_vehicles_userId_fkey FOREIGN KEY ("userId") REFERENCES sisdel_users (id) ON DELETE CASCADE
);

-- 5. Table: sisdel_messages
CREATE TABLE public.sisdel_messages (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "condominioId" text NOT NULL, -- UUID or 'all'
  "fromName" character varying NOT NULL,
  "toRole" character varying NOT NULL,
  subject text NULL,
  body text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  "createdAt" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT sisdel_messages_pkey PRIMARY KEY (id)
);

-- IMPORTANT: 
-- You might want to run the following command to allow anonymous reads and writes 
-- if you are not dealing with RLS right away.
-- WARNING: This exposes APIs, but is required if RLS is not properly configured.
--
-- ALTER TABLE public.condominios ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Enable full access for all users" ON public.condominios FOR ALL USING (true) WITH CHECK (true);
--
--
-- (Repeat for users, visits, vehicles and messages inside the Supabase Auth Policies dashboard).

-- 6. Table: sisdel_camera_logs
CREATE TABLE public.sisdel_camera_logs (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "condominioId" text NULL,
  plate character varying NULL,
  status character varying NULL, -- 'Authorized', 'Denied', 'Error', 'Unknown'
  reason text NULL,
  "rawPayload" jsonb NULL, -- Para guardar todo lo que envía la cámara
  "createdAt" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT sisdel_camera_logs_pkey PRIMARY KEY (id)
);
