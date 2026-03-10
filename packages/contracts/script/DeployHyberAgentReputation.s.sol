// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/HyberAgentReputation.sol";

contract DeployHyberAgentReputation is Script {
    function run() external {
        address identityRegistry = vm.envAddress("AGENT_IDENTITY_ADDRESS");

        vm.startBroadcast();
        HyberAgentReputation reputation = new HyberAgentReputation(identityRegistry);
        vm.stopBroadcast();

        console2.log("HyberAgentReputation deployed at:", address(reputation));
        console2.log("identityRegistry:               ", identityRegistry);
        console2.log("Set AGENT_REPUTATION_ADDRESS =", address(reputation));
    }
}
