// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Attack2Safe
 * @dev Test-only (review D-1 round 3, the attack lane's lookalike): a
 *      Safe-shaped contract whose reads answer, revert, burn the gas or
 *      return no data, per read, and whose module list pages as a Safe
 *      v1.4.1 pages it (`next` is the page's last entry until the end),
 *      or as v1.3.0 does (`next` is the first entry after the page, which
 *      a page started at it skips). With `shownToZero` set, a
 *      zero-address caller is answered those owners instead. Deployed by
 *      no demo or production path.
 */
contract Attack2Safe {
    address private constant SENTINEL = address(1);
    address[] private owners;
    address[] private modules;
    address[] private shownToZero;
    uint256 private threshold;
    // getOwners, getThreshold, getModulesPaginated: 0 answers, 1 revert(),
    // 2 a custom error, 3 burns the gas, 4 returns no data.
    uint8[3] private modes;
    bool private v130;

    error Weird(uint256 a);

    // solhint-disable-next-line func-visibility
    constructor(address[] memory owners_, uint256 threshold_) {
        owners = owners_;
        threshold = threshold_;
    }

    function setModules(address[] calldata m) external {
        modules = m;
    }

    function setModes(uint8 o, uint8 t, uint8 m) external {
        modes = [o, t, m];
    }

    function pageAsV130() external {
        v130 = true;
    }

    function showToZero(address[] calldata a) external {
        shownToZero = a;
    }

    function getOwners() external view returns (address[] memory) {
        _fail(modes[0]);
        if (shownToZero.length != 0 && msg.sender == address(0)) {
            return shownToZero;
        }
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        _fail(modes[1]);
        return threshold;
    }

    function getModulesPaginated(
        address start,
        uint256 pageSize
    ) external view returns (address[] memory page, address next) {
        _fail(modes[2]);
        uint256 i = 0;
        if (start != SENTINEL) {
            while (i < modules.length && modules[i] != start) i++;
            i++;
        }
        uint256 n = i < modules.length ? modules.length - i : 0;
        if (n > pageSize) n = pageSize;
        page = new address[](n);
        for (uint256 j = 0; j < n; j++) page[j] = modules[i + j];
        if (i + n >= modules.length) next = SENTINEL;
        else next = v130 ? modules[i + n] : page[n - 1];
    }

    function _fail(uint8 mode) private pure {
        if (mode == 1) revert(); // solhint-disable-line gas-custom-errors, reason-string
        if (mode == 2) revert Weird(7);
        if (mode == 3) {
            uint256 x;
            while (x != type(uint256).max) x = uint256(keccak256(abi.encode(x)));
        }
        if (mode == 4) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                return(0, 0)
            }
        }
    }
}
