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
        const contentType = req.headers.get('content-type') || '';
        console.log(`📥 Request received - Method: ${req.method}, Content-Type: ${contentType}`);
        console.log(`📥 URL: ${req.url}`);

        // Log all headers for debugging
        const headerObj: Record<string, string> = {};
        req.headers.forEach((value, key) => {
            headerObj[key] = value;
        });
        console.log("📥 Headers:", JSON.stringify(headerObj));

        let rawData: any = {};
        let plateNumber = '';

        // ============================================
        // PARSE REQUEST BODY - Handle multiple formats
        // ============================================

        if (contentType.includes('multipart/form-data')) {
            // ITMS/Dahua sends multipart with JSON metadata + images
            console.log("📦 Parsing as multipart/form-data (ITMS Dahua format)...");
            try {
                const formData = await req.formData();
                // Log all form fields
                for (const [key, value] of formData.entries()) {
                    if (value instanceof File) {
                        console.log(`  📎 File field: ${key}, name: ${value.name}, size: ${value.size}, type: ${value.type}`);
                        // Try to extract plate from filename
                        // Dahua format: P642DPH-20260310114824-plate.jpg
                        if (value.name && !plateNumber) {
                            const parts = value.name.split('-');
                            if (parts.length > 0 && parts[0].length >= 5) {
                                plateNumber = parts[0];
                                console.log(`  🔎 Extracted plate from filename: ${plateNumber}`);
                            }
                        }
                    } else {
                        const strVal = String(value);
                        console.log(`  📝 Text field: ${key} = ${strVal.substring(0, 500)}`);
                        // Try to parse JSON fields
                        try {
                            const jsonVal = JSON.parse(strVal);
                            rawData = { ...rawData, ...jsonVal };
                            // Extract plate from JSON field
                            if (jsonVal?.PlateNumber) plateNumber = jsonVal.PlateNumber;
                            if (jsonVal?.plate) plateNumber = jsonVal.plate;
                            if (jsonVal?.TrafficCar?.PlateNumber) plateNumber = jsonVal.TrafficCar.PlateNumber;
                            if (jsonVal?.info?.PlateNumber) plateNumber = jsonVal.info.PlateNumber;
                        } catch {
                            // Not JSON, store as raw field
                            rawData[key] = strVal;
                        }
                    }
                }
            } catch (e) {
                console.log("⚠️ Failed to parse multipart, trying raw text...", e.message);
                const text = await req.text();
                console.log("📝 Raw body (first 1000 chars):", text.substring(0, 1000));
                rawData = { rawText: text };
            }

        } else if (contentType.includes('application/json')) {
            // Standard JSON POST
            console.log("📦 Parsing as JSON...");
            rawData = await req.json();
            console.log("📥 JSON payload:", JSON.stringify(rawData).substring(0, 2000));

        } else if (contentType.includes('application/x-www-form-urlencoded')) {
            // URL-encoded form data
            console.log("📦 Parsing as URL-encoded form...");
            const formData = await req.formData();
            for (const [key, value] of formData.entries()) {
                rawData[key] = String(value);
                console.log(`  📝 Field: ${key} = ${String(value).substring(0, 500)}`);
            }

        } else if (contentType.includes('text/') || contentType.includes('xml')) {
            // Text or XML payload
            console.log("📦 Parsing as text/XML...");
            const text = await req.text();
            console.log("📝 Text body (first 1000 chars):", text.substring(0, 1000));
            rawData = { rawText: text };
            // Try to extract plate from XML or text
            const plateMatch = text.match(/<PlateNumber>(.*?)<\/PlateNumber>/i) ||
                               text.match(/<plate>(.*?)<\/plate>/i) ||
                               text.match(/"PlateNumber"\s*:\s*"(.*?)"/i);
            if (plateMatch) {
                plateNumber = plateMatch[1];
                console.log(`🔎 Extracted plate from text/XML: ${plateNumber}`);
            }

        } else {
            // Unknown content type - try JSON first, then text
            console.log(`📦 Unknown content-type: '${contentType}', trying to parse...`);
            const bodyText = await req.text();
            console.log("📝 Raw body (first 1000 chars):", bodyText.substring(0, 1000));
            
            if (bodyText.trim()) {
                try {
                    rawData = JSON.parse(bodyText);
                    console.log("✅ Successfully parsed as JSON");
                } catch {
                    rawData = { rawText: bodyText };
                    console.log("ℹ️ Stored as raw text");
                }
            } else {
                console.log("⚠️ Empty body received");
                rawData = { emptyBody: true };
            }
        }

        // ============================================
        // EXTRACT PLATE NUMBER from parsed data
        // ============================================
        if (!plateNumber) {
            // Try all known Dahua JSON structures - including ITMS format
            plateNumber = rawData?.PlateNumber ||
                rawData?.Picture?.Plate?.PlateNumber ||  // ← Dahua ITMS format!
                rawData?.Events?.[0]?.PlateNumber ||
                rawData?.plate ||
                rawData?.info?.PlateNumber ||
                rawData?.TrafficCar?.PlateNumber ||
                rawData?.trafficCar?.plateNumber ||
                rawData?.AlarmInfoPlate?.plateNumber ||
                rawData?.VehicleInfo?.PlateNumber ||
                '';
        }

        // Try to extract from PicName if available (multiple locations)
        if (!plateNumber) {
            const picName = rawData?.PicName || rawData?.Picture?.CutoutPic?.PicName || '';
            if (picName) {
                const parts = picName.split('-');
                if (parts.length > 0 && parts[0].length >= 5) {
                    plateNumber = parts[0];
                    console.log(`🔎 Extracted plate from PicName: ${plateNumber}`);
                }
            }
        }

        // Clean the plate: remove hyphens, spaces, and make uppercase
        plateNumber = plateNumber ? plateNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';

        if (!plateNumber) {
            console.log("⚠️ No plate detected in payload, but responding 200 to keep camera happy.");
            plateNumber = "NOPLATE";
        }

        console.log(`🚦 Plate detected by camera: [${plateNumber}]`);

        // 2. Get condominioId
        const url = new URL(req.url);
        let condominioIdReq = url.searchParams.get('condominioId') || url.searchParams.get('id');

        // Fallback: If not in URL, check if the camera sent it in the JSON
        if (!condominioIdReq) {
            condominioIdReq = rawData?.DeviceID || 
                rawData?.deviceID || 
                rawData?.info?.DeviceID ||
                rawData?.Picture?.SnapInfo?.DeviceID;  // ← Dahua ITMS format!
        }

        if (!condominioIdReq) {
            console.log("⚠️ Missing condominioId in URL and camera payload.");
            // Still log the event even without condominioId for debugging
            const supabaseClient = createClient(
                Deno.env.get('SUPABASE_URL') ?? '',
                Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
            );
            await supabaseClient.from('sisdel_camera_logs').insert([{
                plate: plateNumber || 'UNKNOWN',
                status: 'Error',
                reason: 'Missing condominioId',
                rawPayload: rawData
            }]);

            return new Response(JSON.stringify({ error: 'condominioId is required, but event was logged' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            })
        }

        // 3. Connect to Supabase to verify the plate
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // ============================================
        // DEDUPLICATION: Skip if same plate was logged in last 30 seconds
        // Dahua cameras send 3+ notifications per detection event
        // ============================================
        const thirtySecsAgo = new Date(Date.now() - 30000).toISOString();
        const { data: recentLogs } = await supabaseClient
            .from('sisdel_camera_logs')
            .select('id')
            .eq('condominioId', condominioIdReq)
            .eq('plate', plateNumber)
            .gte('createdAt', thirtySecsAgo)
            .limit(1);

        if (recentLogs && recentLogs.length > 0) {
            console.log(`⏭️ Duplicate skipped: ${plateNumber} was already logged within 30s`);
            return new Response(JSON.stringify({
                Command: "OK",
                Message: "Duplicate skipped",
                Plate: plateNumber
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            })
        }

        let isAuthorized = false;
        let authReason = '';
        let isReminder = false; // New: grace period reminder for morosos
        let isMoroso = false; // Track if the plate belongs to a moroso resident

        // A. Check if it's a RESIDENT's vehicle (sisdel_vehicles)
        const { data: vecVehicles, error: errVec } = await supabaseClient
            .from('sisdel_vehicles')
            .select('plate, userId, users:userId(name, active, paymentStatus, morosoSince)')
            .eq('condominioId', condominioIdReq)
            .ilike('plate', `%${plateNumber}%`);

        if (!errVec && vecVehicles && vecVehicles.length > 0) {
            const exactMatch = vecVehicles.find(v => v.plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === plateNumber);

            if (exactMatch) {
                const owner = Array.isArray(exactMatch.users) ? exactMatch.users[0] : exactMatch.users;
                if (owner && owner.active !== false) {
                    // Check if resident is moroso
                    if (owner.paymentStatus === 'moroso') {
                        // Get condominium settings to check if reminder is enabled
                        const { data: condoSettings } = await supabaseClient
                            .from('sisdel_condominios')
                            .select('reminderEnabled, gracePeriodDays')
                            .eq('id', condominioIdReq)
                            .single();

                        if (condoSettings?.reminderEnabled) {
                            const graceDays = condoSettings.gracePeriodDays || 15;
                            const morosoSince = owner.morosoSince ? new Date(owner.morosoSince) : new Date();
                            const now = new Date();
                            const daysSinceMoroso = Math.floor((now.getTime() - morosoSince.getTime()) / (1000 * 60 * 60 * 24));
                            const daysRemaining = graceDays - daysSinceMoroso;

                            if (daysRemaining > 0) {
                                // Still in grace period - allow access but mark as reminder
                                isAuthorized = true; // Allow access
                                isReminder = true;
                                authReason = `⚠️ ${owner.name} - MOROSO (${daysRemaining} días restantes para pagar)`;
                                console.log(`⚠️ Reminder Access (Grace Period): ${owner.name}, ${daysRemaining} days left`);
                            } else {
                                // Grace period expired - deny access
                                isMoroso = true;
                                authReason = `🟠 ${owner.name} - MOROSO (Período de gracia vencido)`;
                                console.log(`🚫 Access Denied (Grace Expired): ${owner.name}`);
                            }
                        } else {
                            // No reminder enabled - just deny moroso
                            isMoroso = true;
                            authReason = `🟠 ${owner.name} - MOROSO (pagos pendientes)`;
                            console.log("⚠️ Plate matches resident, but user is moroso (no grace period).");
                        }
                    } else {
                        // Resident is al_dia - normal access
                        isAuthorized = true;
                        authReason = `Vecino permanente: ${owner.name}`;
                        console.log("✅ Access Authorized (Resident):", authReason);
                    }
                } else {
                    console.log("⚠️ Plate matches resident, but user is inactive.");
                }
            }
        }

        // B. Check if it's an expected VISIT for TODAY or TEMPORAL visit (sisdel_visits)
        let visitIdToUpdate = null;

        if (!isAuthorized) {
            const todayStr = new Date().toISOString().split('T')[0];

            // B1. Check normal pending visits
            const { data: visVehicles, error: errVis } = await supabaseClient
                .from('sisdel_visits')
                .select('id, visitorName, vehiclePlate, status, visitType, endDate')
                .eq('condominioId', condominioIdReq)
                .in('status', ['pending', 'entered']);

            if (!errVis && visVehicles && visVehicles.length > 0) {
                const validVisit = visVehicles.find(v => {
                    if (!v.vehiclePlate) return false;
                    const cleanVisitPlate = v.vehiclePlate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                    const plateMatch = cleanVisitPlate.includes(plateNumber) || plateNumber.includes(cleanVisitPlate);
                    if (!plateMatch) return false;

                    // For temporal visits, check if within date range
                    if (v.visitType === 'temporal' && v.endDate) {
                        return todayStr <= v.endDate; // Still valid
                    }
                    // For normal visits, only pending ones
                    return v.status === 'pending';
                });

                if (validVisit) {
                    isAuthorized = true;
                    visitIdToUpdate = validVisit.status === 'pending' ? validVisit.id : null;
                    const isTemp = validVisit.visitType === 'temporal';
                    authReason = isTemp 
                        ? `Vecino temporal: ${validVisit.visitorName} (hasta ${validVisit.endDate})`
                        : `Visita programada: ${validVisit.visitorName}`;
                    console.log("✅ Access Authorized (Visit):", authReason);
                }
            }
        }

        // Determine final status
        // 🟢 Authorized = residente al día / visita válida
        // 🟠 Moroso = residente con pagos pendientes (placa conocida pero moroso)
        // 🟠 Reminder = moroso en período de gracia (acceso permitido con alerta)
        // 🔴 Denied = placa desconocida / no registrada
        const logStatus = isReminder ? 'Reminder' : (isAuthorized ? 'Authorized' : (isMoroso ? 'Moroso' : 'Denied'));

        // 4. Save camera log to database
        await supabaseClient.from('sisdel_camera_logs').insert([{
            condominioId: condominioIdReq,
            plate: plateNumber || 'UNKNOWN',
            status: logStatus,
            reason: isAuthorized ? authReason : (isMoroso ? authReason : 'Placa no registrada'),
            rawPayload: rawData
        }]);

        // 5. Respond to the camera
        if (isAuthorized) {
            if (visitIdToUpdate) {
                await supabaseClient
                    .from('sisdel_visits')
                    .update({ status: 'entered', enteredAt: new Date().toISOString() })
                    .eq('id', visitIdToUpdate);

                console.log(`📝 Visit ${visitIdToUpdate} marked as entered.`);
            }

            return new Response(JSON.stringify({
                Command: "Open",
                Message: "Authorized",
                Reason: authReason,
                Plate: plateNumber
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            })
        } else {
            console.log(`❌ Access Denied for plate: ${plateNumber} (${isMoroso ? 'MOROSO' : 'NO REGISTRADA'})`);
            return new Response(JSON.stringify({
                Command: "Close",
                Message: isMoroso ? "Moroso" : "Denied",
                Reason: isMoroso ? authReason : "Placa no registrada",
                Plate: plateNumber,
                IsMoroso: isMoroso
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            })
        }

    } catch (error) {
        console.error("❌ Catch Error in ANPR webhook:", error.message);
        console.error("❌ Stack:", error.stack);

        // Try to log the error even if main processing failed
        try {
            const supabaseClient = createClient(
                Deno.env.get('SUPABASE_URL') ?? '',
                Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
            );
            await supabaseClient.from('sisdel_camera_logs').insert([{
                plate: 'ERROR',
                status: 'Error',
                reason: error.message,
                rawPayload: { error: error.message, stack: error.stack }
            }]);
        } catch (logError) {
            console.error("❌ Failed to log error:", logError.message);
        }

        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        })
    }
})
