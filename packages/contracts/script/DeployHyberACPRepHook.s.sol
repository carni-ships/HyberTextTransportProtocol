// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/HyberACPRepHook.sol";

contract DeployHyberACPRepHook is Script {
    function run() external {
        address acp        = vm.envAddress("ACP_ADDRESS");
        address identity   = vm.envAddress("AGENT_IDENTITY_ADDRESS");
        address reputation = vm.envAddress("AGENT_REPUTATION_ADDRESS");

        vm.startBroadcast();
        HyberACPRepHook hook = new HyberACPRepHook(acp, identity, reputation);
        vm.stopBroadcast();

        console2.log("HyberACPRepHook deployed at:", address(hook));
        console2.log("  acp:        ", acp);
        console2.log("  identity:   ", identity);
        console2.log("  reputation: ", reputation);
        console2.log("Set ACP_REP_HOOK_ADDRESS =", address(hook));
        console2.log("");
        console2.log("Pass hook= address to research_bounty_create so ERC-8183 jobs");
        console2.log("automatically write ERC-8004 reputation on complete/reject.");
    }
}
