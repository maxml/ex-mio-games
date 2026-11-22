// Unit-test environment, the same value compose gives identity (D-30): the simulator is the one host
// a production reward API may reach over plain http. D30-HTTPS-1 clears and restores it itself.
process.env.REWARD_API_ALLOW_HOSTS ??= 'casino-sim';
