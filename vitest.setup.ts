process.env.OARS_TELEMETRY = '0';
// Telemetry is off in the EU, the EEA, and the UK (t1072): pin the zone so a suite run on a machine there behaves as it does elsewhere.
process.env.TZ = 'America/New_York';
