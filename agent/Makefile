# mDEV_agent - plain Makefile (host builds and OpenWrt SDK cross builds)
#
# Host build (plain ws://, no TLS):
#   make
#
# Host build with TLS (needs mbedtls dev headers):
#   make MDEV_WITH_TLS=1
#
# Cross build through an OpenWrt SDK:
#   make CC=.../mipsel-openwrt-linux-musl-gcc \
#        STAGING=.../staging_dir/target-mipsel_24kc_musl MDEV_WITH_TLS=1
#
# The OpenWrt package build (openwrt/Makefile) drives this file too.

BIN      := mDEV_agent
SRCDIR   := src
OBJDIR   := build

SRCS     := $(SRCDIR)/main.c $(SRCDIR)/util.c $(SRCDIR)/net.c \
            $(SRCDIR)/ws.c $(SRCDIR)/sha1.c $(SRCDIR)/json.c $(SRCDIR)/cmd.c
OBJS     := $(patsubst $(SRCDIR)/%.c,$(OBJDIR)/%.o,$(SRCS))
DEPS     := $(OBJS:.o=.d)

CC       ?= cc
STRIP    ?= strip

# -Os matters more than -O2 on a 16 MB device.
WARNINGS := -Wall -Wextra -Wno-unused-parameter
CFLAGS   ?= -Os -pipe -fno-plt
CFLAGS   += $(WARNINGS) -std=gnu99 -ffunction-sections -fdata-sections \
            -fno-asynchronous-unwind-tables -fno-unwind-tables
CPPFLAGS += -I$(SRCDIR) -MMD -MP
LDFLAGS  += -Wl,--gc-sections -Wl,--as-needed

# Harden: full RELRO, stack protector, PIE, FORTIFY.
CFLAGS   += -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE
LDFLAGS  += -Wl,-z,relro,-z,now -pie

# STAGING points at an OpenWrt staging_dir/target-* tree.
ifneq ($(STAGING),)
CPPFLAGS += -I$(STAGING)/usr/include
LDFLAGS  += -L$(STAGING)/usr/lib
endif

ifeq ($(MDEV_WITH_TLS),1)
CPPFLAGS += -DMDEV_WITH_TLS=1
LIBS     += -lmbedtls -lmbedx509 -lmbedcrypto
endif

.PHONY: all clean strip size test
all: $(BIN)

$(BIN): $(OBJS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^ $(LIBS)

$(OBJDIR)/%.o: $(SRCDIR)/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) $(CPPFLAGS) -c -o $@ $<

$(OBJDIR):
	mkdir -p $(OBJDIR)

strip: $(BIN)
	$(STRIP) $(BIN)

size: $(BIN)
	@ls -l $(BIN) | awk '{printf "%s  %d bytes\n", $$NF, $$5}'

# Self-tests for the pure logic (SHA-1/Base64, JSON, URL/MAC parsing).
test: tests/run_tests.c $(SRCDIR)/sha1.c $(SRCDIR)/json.c $(SRCDIR)/util.c
	$(CC) -std=gnu99 $(WARNINGS) -O1 -g -I$(SRCDIR) -o $(OBJDIR)/run_tests $^ && $(OBJDIR)/run_tests

clean:
	rm -rf $(OBJDIR) $(BIN)

-include $(DEPS)
