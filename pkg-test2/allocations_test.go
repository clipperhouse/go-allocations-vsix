package top

import (
	"math/rand"
	"strconv"
	"testing"
)

func BenchmarkNoAllocations(b *testing.B) {
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

func BenchmarkWithAllocs(b *testing.B) {
	for b.Loop() {
		makeSomeAllocs()
	}
}
