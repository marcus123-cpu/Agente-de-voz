import { ameiStatus, ameiFreeSlots, ameiPatientAppointments } from '../server/src/amei.ts';
const st = await ameiStatus();
console.log('status:', JSON.stringify(st));
if (st.loggedIn) {
  const arg = process.argv[2];
  if (arg) console.log(await ameiFreeSlots({ especialidade: arg }));
  const phone = process.argv[3];
  if (phone) console.log(await ameiPatientAppointments(phone));
}
process.exit(0);
