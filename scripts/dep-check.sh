#! /usr/bin/env bash

function main() {
	local MODULE
	MODULE=$(basename "$(pwd)")

	local SUSPICIOUS_DEPS
	SUSPICIOUS_DEPS=()

	local IMPORT REQUIRE
	for dep in $(jq -r ''"$KEY"' | keys | .[]' package.json); do
		IMPORT="from.*[\"\']${dep}[\"\']"
		REQUIRE="require\(.*$dep.*\)"
		if ! grep "$IMPORT\|$REQUIRE" -Rq --exclude-dir="node_modules" .; then
			SUSPICIOUS_DEPS+=("$dep")
		fi
	done

	if [ ${#SUSPICIOUS_DEPS[@]} -gt 0 ]; then
		printf "\n## %s\n\n" "${MODULE}"
		for dep in "${SUSPICIOUS_DEPS[@]}"; do
			printf "  - [ ] %s\n" "$dep"
		done
	fi
}

function usage() {
	printf "%s [-dh]\n" "$0"
	printf "\t-d\t use devDpendencies\n"
	printf "\t-h\t display help\n\n"
	exit
}

KEY=".dependencies"

while getopts ':dh' opt; do
	case "$opt" in
		d)
			KEY=".devDependencies"
			;;
		h) usage ;;
		/?)
			echo unknown command
			exit
			;;
	esac
done

shift $((OPTIND - 1))

main
