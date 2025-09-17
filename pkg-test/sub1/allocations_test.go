package sub1

import (
	"math/rand"
	"strconv"
	"testing"
)

func BenchmarkNoAllocationsSub1(b *testing.B) {
	for b.Loop() {
		rand.Intn(1000)
	}
}

func makeSomeAllocs() []string {
	var slice []string
	s := "hello" + strconv.Itoa(rand.Intn(1000))
	for range 100 {
		slice = append(slice, s)
	}
	return slice
}

func BenchmarkWithAllocsSub1(b *testing.B) {
	for b.Loop() {
		makeSomeAllocs()
	}
}
