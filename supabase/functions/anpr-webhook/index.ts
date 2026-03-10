import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
    // CORS configuration to accept requests from the camera or web
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    }

    // Pre-flight request handler
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        // 1. Get the request payload from the Dahua camera
        const rawData = await req.json()

        console.log("📥 Raw payload from Dahua ANPR:", JSON.stringify(rawData));

        // Dahua ITC413 specific JSON structure adaptation (will be adjusted after first real test)
        // Often it comes inside an "Events" array or directly as "PlateNumber"
        let plateNumber = rawData?.PlateNumber ||
            rawData?.Events?.[0]?.PlateNumber ||
            rawData?.plate ||
            rawData?.info?.PlateNumber || '';

        // Clean the plate: remove hyphens, spaces, and make uppercase (e.g., "P-123 ABC" -> "P123ABC")
        plateNumber = plateNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

        if (!plateNumber) {
            console.log("⚠️ No plate detected in payload:", JSON.stringify(rawData));
            return new Response(JSON.stringify({ error: 'No plate detected in payload' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 400,
            })
        }

        console.log(`🚦 Plate detected by camera: [${plateNumber}]`);

        // 2. Connect to Supabase to verify the plate
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' // Used to bypass RLS in the edge function safely
        )

        let isAuthorized = false;
        let authReason = '';

        // A. Check if it's a RESIDENT's vehicle (sisdel_vehicles)
        // We use ilike and % to find partial matches, ignoring the hyphen in DB (e.g. DB: "P-123ABC", Camera: "P123ABC")
        const sqlLikePlate = `%${plateNumber.replace('P', 'P%').replace('M', 'M%').replace('C', 'C%')}%`; // basic logic to handle GT plates formatting flexibly

        const { data: vecVehicles, error: errVec } = await supabaseClient
            .from('sisdel_vehicles')
            .select('plate, users:userId(name, active)')
            .ilike('plate', `%${plateNumber}%`); // Basic matching for now

        if (!errVec && vecVehicles && vecVehicles.length > 0) {
            // Find if the exact alphanumeric sequence matches (ignoring symbols)
            const exactMatch = vecVehicles.find(v => v.plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === plateNumber);

            if (exactMatch) {
                const owner = Array.isArray(exactMatch.users) ? exactMatch.users[0] : exactMatch.users;
                if (owner && owner.active !== false) {
                    isAuthorized = true;
                    authReason = `Vecino permanente: ${owner.name}`;
                    console.log("✅ Access Authorized (Resident):", authReason);
                } else {
                    console.log("⚠️ Plate matches resident, but user is inactive.");
                }
            }
        }

        // B. Check if it's an expected VISIT for TODAY (sisdel_visits)
        let visitIdToUpdate = null;

        if (!isAuthorized) {
            // Note: Deno Edge Functions run in UTC, we should adjust to local time (Guatemala UTC-6) if strict date matters.
            // For simplicity, we just check pending visits. A robust system would check the `visitDate`.
            const { data: visVehicles, error: errVis } = await supabaseClient
                .from('sisdel_visits')
                .select('id, visitorName, vehiclePlate, status')
                .eq('status', 'pending');

            if (!errVis && visVehicles && visVehicles.length > 0) {
                // Find a visit where the clean plate matches the camera's clean plate
                const validVisit = visVehicles.find(v => {
                    if (!v.vehiclePlate) return false;
                    const cleanVisitPlate = v.vehiclePlate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                    return cleanVisitPlate.includes(plateNumber) || plateNumber.includes(cleanVisitPlate);
                });

                if (validVisit) {
                    isAuthorized = true;
                    visitIdToUpdate = validVisit.id;
                    authReason = `Visita programada: ${validVisit.visitorName}`;
                    console.log("✅ Access Authorized (Visit):", authReason);
                }
            }
        }

        // 3. Guardar el historial de la cámara en la base de datos
        await supabaseClient.from('sisdel_camera_logs').insert([{
            plate: plateNumber || 'UNKNOWN',
            status: isAuthorized ? 'Authorized' : 'Denied',
            reason: isAuthorized ? authReason : 'Placa no registrada',
            rawPayload: rawData
        }]);

        // 4. Responder a la cámara
        // A veces la cámara espera un JSON para activar el relé, 
        // o si está configurada para abrir con un HTTP 200 OK.

        if (isAuthorized) {
            // Mark visit as entered if applicable
            if (visitIdToUpdate) {
                await supabaseClient
                    .from('sisdel_visits')
                    .update({ status: 'entered', enteredAt: new Date().toISOString() })
                    .eq('id', visitIdToUpdate);

                console.log(`📝 Visit ${visitIdToUpdate} marked as entered.`);
            }

            // Return success response to camera
            // Depending on Dahua firmware, returning 200 OK might be enough to trigger the "Alarm Out" if configured to do so on successful POST.
            return new Response(JSON.stringify({
                Command: "Open", // Some firmwares look for this
                Message: "Authorized",
                Reason: authReason,
                Plate: plateNumber
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            })
        } else {
            console.log(`❌ Access Denied for plate: ${plateNumber}`);
            // Return 403 Forbidden or 200 with "Denied" payload depending on what Dahua expects to NOT open.
            // Often 200 OK with a specific payload is safer so the camera doesn't log unending HTTP errors.
            return new Response(JSON.stringify({
                Command: "Close",
                Message: "Denied",
                Reason: "Placa no registrada",
                Plate: plateNumber
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 403, // Using 403 explicitly tells the camera "forbidden"
            })
        }

    } catch (error) {
        console.error("❌ Catch Error in ANPR webhook:", error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        })
    }
})
