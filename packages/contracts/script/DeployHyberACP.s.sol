// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/HyberACP.sol";

contract DeployHyberACP is Script {
    function run() external {
        uint16  feeBps       = uint16(vm.envOr("ACP_FEE_BPS",       uint256(0)));
        address feeRecipient = vm.envOr("ACP_FEE_RECIPIENT",        msg.sender);

        vm.startBroadcast();
        HyberACP acp = new HyberACP(feeBps, feeRecipient);
        vm.stopBroadcast();

        console2.log("HyberACP deployed at:", address(acp));
        console2.log("feeBps:              ", feeBps);
        console2.log("feeRecipient:        ", feeRecipient);
    }
}
