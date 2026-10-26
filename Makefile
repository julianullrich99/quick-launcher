UUID    := quick-launcher@julian.falcondev.de
BUILD   := dist
TARGET  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP     := $(UUID).shell-extension.zip

.PHONY: all build schemas assets install reload uninstall pack test check screenshots clean enable disable logs

all: assets

build:
	rm -rf $(BUILD)
	npx tsc -p tsconfig.json

schemas: build
	mkdir -p $(BUILD)/schemas
	cp src/schemas/*.gschema.xml $(BUILD)/schemas/
	glib-compile-schemas --strict $(BUILD)/schemas

assets: schemas
	cp src/metadata.json src/stylesheet.css $(BUILD)/
	cp -r src/icons $(BUILD)/
	mkdir -p $(BUILD)/emoji && cp src/emoji/emoji.json $(BUILD)/emoji/

install: assets
	rm -rf $(TARGET)
	mkdir -p $(TARGET)
	cp -r $(BUILD)/. $(TARGET)/
	@echo "Installed to $(TARGET)"
	@echo "Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

# Swaps in the latest build without logging out; needs one log out after the first run.
reload: assets
	@test -f $(TARGET)/live/current || echo "First reload: log out and back in once, after that make reload is enough"
	$(eval VERSION := $(shell date +%s%N))
	mkdir -p $(TARGET)
	rm -rf $(TARGET)/live
	cp -r $(BUILD)/. $(TARGET)/
	mkdir -p $(TARGET)/live/$(VERSION)
	cp -r $(BUILD)/. $(TARGET)/live/$(VERSION)/
	cp tools/dev-loader.js $(TARGET)/extension.js
	echo $(VERSION) > $(TARGET)/live/current
	-gnome-extensions disable $(UUID)
	gnome-extensions enable $(UUID)

uninstall:
	rm -rf $(TARGET)

pack: assets
	rm -f $(ZIP)
	cd $(BUILD) && zip -qr ../$(ZIP) .
	@echo "Wrote $(ZIP)"

test:
	node --test 'test/*.test.ts'

check:
	npx tsc -p tsconfig.json --noEmit
	npx tsc -p test
	npx eslint .
	node --test 'test/*.test.ts'

screenshots: assets
	./tools/shoot.sh

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf $(BUILD) $(ZIP)
